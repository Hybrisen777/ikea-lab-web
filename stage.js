// Renderer, background and lights shared by the assembly player (player.js) and the twin player (twin.js) - same
// look as Unity's App scene: directional light rotation (50,145,0) with soft shadows + ambient + weak reflections.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const DEG = Math.PI / 180;
export const srgb = c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);   // Unity colours are sRGB

export function createStage(container, background) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;

  const scene = new THREE.Scene();
  scene.background = srgb(background || [0.93, 0.93, 0.92]);

  // reflections for metal parts (bolts, screws) like Unity's ambient reflection; hemisphere = ambient light
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  scene.add(new THREE.HemisphereLight(0xffffff, srgb([0.62, 0.6, 0.57]), 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  // Unity light forward = Euler(50,145,0) * (0,0,1) = (0.369, -0.766, -0.527); towards the light = (-0.369, 0.766, 0.527)
  // in Unity axes = (0.369, 0.766, 0.527) in glTF (x negated)
  const sunDir = new THREE.Vector3(Math.sin(145 * DEG) * Math.cos(50 * DEG), Math.sin(50 * DEG), -Math.cos(145 * DEG) * Math.cos(50 * DEG));
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);

  // shadow camera covering a sphere (centre, radius) of the stage
  function fitShadow(center, r) {
    sun.target.position.copy(center); sun.position.copy(center).addScaledVector(sunDir, r + 2);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: 2 * r + 4 }); sun.shadow.camera.updateProjectionMatrix();
  }
  const stageMat = c => new THREE.MeshStandardMaterial({ color: srgb(c), roughness: 0.9, envMapIntensity: 0 });
  return { renderer, scene, sun, sunDir, fitShadow, stageMat };
}
