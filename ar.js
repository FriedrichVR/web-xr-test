import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const modelUrl = new URL('./models/Van_v02.glb', window.location.href);
const launchButton = document.querySelector('#ar-button');
const exitButton = document.querySelector('#exit-ar');
const statusElement = document.querySelector('#ar-status');
const instructions = document.querySelector('#ar-instructions');
const overlay = document.querySelector('#ar-overlay');
const previewCanvas = document.querySelector('#preview-canvas');
const moveButtons = [...document.querySelectorAll('#ar-controls [data-action]')];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f0f0);
const camera = new THREE.PerspectiveCamera();
const renderer = new THREE.WebGLRenderer({canvas: previewCanvas, alpha: true, antialias: true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xf0f0f0, 1);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.7, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2);
keyLight.position.set(2, 5, 3);
scene.add(keyLight);

const modelRoot = new THREE.Group();
scene.add(modelRoot);
let model = null;
let hitTestSource = null;
let xrSession = null;
let placed = false;
let lastFloorHit = null;
let floorAnchor = null;
let scale = 1;
let floorY = 0;
let grabbedController = null;
let previousFrameTime = 0;
let lastAnchorPosition = new THREE.Vector3();
const manualOffset = new THREE.Vector3();
const grabOffset = new THREE.Vector3();
const controllerPosition = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const raycaster = new THREE.Raycaster();
const hitNormal = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const viewForward = new THREE.Vector3(0, 0, -1);
const viewOrientation = new THREE.Quaternion();
let lastGrowPressed = false;
let lastShrinkPressed = false;

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 32),
  new THREE.MeshBasicMaterial({color: 0x40cbcb, side: THREE.DoubleSide})
);
reticle.rotation.x = -Math.PI / 2;
reticle.visible = false;
scene.add(reticle);

function report(message) {
  statusElement.textContent = message;
}

function setPlacedControlsEnabled(enabled) {
  for (const button of moveButtons) {
    button.disabled = !enabled;
  }
}

function setScale(nextScale) {
  scale = THREE.MathUtils.clamp(nextScale, 0.1, 5);
  modelRoot.scale.setScalar(scale);
}

function viewDirections() {
  forward.copy(viewForward);
  forward.y = 0;
  if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
  forward.normalize();
  right.set(forward.z, 0, -forward.x).normalize();
}

function translateModel(offset) {
  modelRoot.position.add(offset);
  if (floorAnchor) manualOffset.add(offset);
}

function moveModel(action, amount = 0.1) {
  if (!placed) return;
  viewDirections();
  switch (action) {
    case 'forward':
      translateModel(forward.clone().multiplyScalar(amount));
      break;
    case 'back':
      translateModel(forward.clone().multiplyScalar(-amount));
      break;
    case 'left':
      translateModel(right.clone().multiplyScalar(-amount));
      break;
    case 'right':
      translateModel(right.clone().multiplyScalar(amount));
      break;
    case 'up':
      translateModel(new THREE.Vector3(0, amount, 0));
      break;
    case 'down': {
      const distanceAboveFloor = modelRoot.position.y - floorY;
      translateModel(new THREE.Vector3(0, -Math.min(amount, distanceAboveFloor), 0));
      break;
    }
    case 'scale-up':
      setScale(scale * 1.1);
      break;
    case 'scale-down':
      setScale(scale / 1.1);
      break;
  }
}

function placeModel(position, anchor = null) {
  modelRoot.position.copy(position);
  modelRoot.rotation.y = Math.atan2(-viewForward.x, -viewForward.z);
  floorY = position.y;
  lastAnchorPosition.copy(position);
  manualOffset.set(0, 0, 0);
  placed = true;
  floorAnchor = anchor;
  reticle.visible = false;
  setPlacedControlsEnabled(true);
  instructions.textContent =
    'Sticks: mover y subir/bajar. Pulsa el gatillo sobre la van para sujetarla. Botones: mover y ajustar tamaño.';
  report(anchor ? 'Modelo colocado y anclado al espacio.' : 'Modelo colocado en el suelo.');
}

async function placeAtLastHit() {
  if (!lastFloorHit) {
    report('No detecto el suelo todavía. Mueve el visor lentamente y vuelve a intentarlo.');
    return;
  }

  let anchor = null;
  if (typeof lastFloorHit.createAnchor === 'function') {
    try {
      anchor = await lastFloorHit.createAnchor();
    } catch (error) {
      console.warn('No se pudo crear un ancla WebXR; se usará la posición detectada.', error);
    }
  }
  placeModel(reticle.position.clone(), anchor);
}

function rayHitsModel(controller) {
  if (!model) return false;
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  return raycaster.intersectObject(model, true).length > 0;
}

function onControllerSelectStart(controller) {
  if (!placed) {
    void placeAtLastHit();
    return;
  }
  if (rayHitsModel(controller)) {
    grabbedController = controller;
    controller.getWorldPosition(controllerPosition);
    grabOffset.copy(modelRoot.position).sub(controllerPosition);
  }
}

function onControllerSelectEnd(controller) {
  if (grabbedController === controller) grabbedController = null;
}

function connectController(index) {
  const controller = renderer.xr.getController(index);
  controller.addEventListener('selectstart', () => onControllerSelectStart(controller));
  controller.addEventListener('selectend', () => onControllerSelectEnd(controller));
  scene.add(controller);
  return controller;
}

function getStickAxes(gamepad) {
  if (!gamepad || gamepad.axes.length < 2) return [0, 0, 0, 0];
  if (gamepad.axes.length >= 4) {
    return [gamepad.axes[2], gamepad.axes[3]];
  }
  return [gamepad.axes[0], gamepad.axes[1]];
}

function deadzone(value) {
  if (Math.abs(value) < 0.16) return 0;
  return Math.sign(value) * (Math.abs(value) - 0.16) / 0.84;
}

function updateControllers(delta) {
  const session = renderer.xr.getSession();
  if (!session || !placed) return;

  const sources = [...session.inputSources];
  const left = sources.find(source => source.handedness === 'left');
  const rightHand = sources.find(source => source.handedness === 'right');

  if (left?.gamepad) {
    const [x, y] = getStickAxes(left.gamepad);
    viewDirections();
    translateModel(right.clone().multiplyScalar(deadzone(x) * delta * 0.7));
    translateModel(forward.clone().multiplyScalar(-deadzone(y) * delta * 0.7));
  }

  if (rightHand?.gamepad) {
    const [x, y] = getStickAxes(rightHand.gamepad);
    moveModel(y < 0 ? 'up' : 'down', Math.abs(deadzone(y)) * delta * 0.7);
    modelRoot.rotation.y -= deadzone(x) * delta;

    const buttons = rightHand.gamepad.buttons;
    const growPressed = buttons[4]?.pressed ?? false;
    const shrinkPressed = buttons[5]?.pressed ?? false;
    if (growPressed && !lastGrowPressed) moveModel('scale-up');
    if (shrinkPressed && !lastShrinkPressed) moveModel('scale-down');
    lastGrowPressed = growPressed;
    lastShrinkPressed = shrinkPressed;
  }
}

function renderFrame(time, frame) {
  if (!frame) controls.update();

  if (frame) {
    const viewerPose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (viewerPose) {
      const orientation = viewerPose.transform.orientation;
      viewOrientation.set(orientation.x, orientation.y, orientation.z, orientation.w);
      viewForward.set(0, 0, -1).applyQuaternion(viewOrientation);
      viewForward.y = 0;
      if (viewForward.lengthSq() > 0.001) viewForward.normalize();
    }
  }

  if (frame && !placed && hitTestSource) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const results = frame.getHitTestResults(hitTestSource);
    lastFloorHit = null;
    reticle.visible = false;

    for (const result of results) {
      const pose = result.getPose(referenceSpace);
      if (!pose) continue;
      hitNormal.set(pose.transform.matrix[4], pose.transform.matrix[5], pose.transform.matrix[6]);
      if (hitNormal.y < 0.75) continue;
      reticle.position.set(
        pose.transform.position.x,
        pose.transform.position.y + 0.005,
        pose.transform.position.z
      );
      reticle.visible = true;
      lastFloorHit = result;
      break;
    }
  }

  const delta = previousFrameTime ? Math.min((time - previousFrameTime) / 1000, 0.05) : 0;
  previousFrameTime = time;

  if (grabbedController) {
    grabbedController.getWorldPosition(controllerPosition);
    modelRoot.position.copy(controllerPosition).add(grabOffset);
    if (floorAnchor) manualOffset.copy(modelRoot.position).sub(lastAnchorPosition);
  }
  updateControllers(delta);

  if (frame && floorAnchor && placed) {
    const pose = frame.getPose(floorAnchor.anchorSpace, renderer.xr.getReferenceSpace());
    if (pose) {
      lastAnchorPosition.set(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z
      );
      if (!grabbedController) modelRoot.position.copy(lastAnchorPosition).add(manualOffset);
    }
  }

  renderer.render(scene, camera);
}

function resizeRenderer() {
  const isAR = document.body.classList.contains('ar-active');
  const width = isAR ? window.innerWidth : previewCanvas.clientWidth;
  const height = isAR ? window.innerHeight : previewCanvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function cleanUpSession() {
  renderer.setAnimationLoop(renderFrame);
  hitTestSource?.cancel();
  hitTestSource = null;
  floorAnchor = null;
  xrSession = null;
  grabbedController = null;
  placed = false;
  lastFloorHit = null;
  previousFrameTime = 0;
  modelRoot.position.set(0, 0, 0);
  modelRoot.rotation.set(0, 0, 0);
  setScale(1);
  manualOffset.set(0, 0, 0);
  reticle.visible = false;
  setPlacedControlsEnabled(false);
  overlay.classList.remove('active');
  document.body.classList.remove('ar-active');
  controls.enabled = true;
  scene.background = new THREE.Color(0xf0f0f0);
  renderer.setClearColor(0xf0f0f0, 1);
  resizeRenderer();
  launchButton.disabled = false;
  launchButton.textContent = 'Ver en mi espacio';
}

async function startAR() {
  launchButton.disabled = true;
  report('Comprobando compatibilidad AR...');
  overlay.classList.add('active');
  document.body.classList.add('ar-active');

  try {
    if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-ar'))) {
      throw new Error('Este navegador no admite WebXR en modo AR. Usa Meta Quest Browser en Quest 3.');
    }

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay', 'anchors'],
      domOverlay: {root: overlay}
    });
    xrSession = session;
    controls.enabled = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    resizeRenderer();
    await renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({space: viewerSpace});
    session.addEventListener('end', cleanUpSession, {once: true});
    renderer.setAnimationLoop(renderFrame);

    report('AR activa. Apunta al suelo para detectar una superficie.');
  } catch (error) {
    const session = xrSession;
    cleanUpSession();
    if (session) {
      try {
        await session.end();
      } catch (endError) {
        console.error('No se pudo cerrar la sesión WebXR después del error.', endError);
      }
    }
    report(error instanceof Error ? error.message : 'No se pudo iniciar la sesión AR.');
    console.error('Error al iniciar WebXR AR:', error);
  }
}

async function loadModel() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelUrl.href);
  model = gltf.scene;

  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  model.position.set(-center.x, -bounds.min.y, -center.z);
  model.traverse(object => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  modelRoot.add(model);
  controls.target.set(0, size.y / 2, 0);
  camera.position.set(size.x * 1.8, size.y * 1.3, size.z * 1.8);
  camera.near = Math.max(size.length() / 1000, 0.01);
  camera.far = Math.max(size.length() * 20, 100);
  camera.updateProjectionMatrix();
  controls.update();
  report('Modelo 3D listo. Inicia AR para colocarlo en el piso.');
}

launchButton.addEventListener('click', () => void startAR());
exitButton.addEventListener('click', () => void xrSession?.end());
for (const button of moveButtons) {
  button.addEventListener('click', () => moveModel(button.dataset.action));
}
for (let index = 0; index < 2; index += 1) {
  connectController(index);
}
window.addEventListener('resize', resizeRenderer);
setPlacedControlsEnabled(false);
resizeRenderer();
renderer.setAnimationLoop(renderFrame);
loadModel().catch(error => {
  report('No se pudo cargar el modelo 3D.');
  console.error('Error al cargar el modelo 3D:', error);
});
