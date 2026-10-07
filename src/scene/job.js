// A "job" is everything the renderer needs for one file.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { parseModel } from '../rbx/model.js';
import { buildScene } from './build.js';
import { buildVfx } from './vfx.js';
import { samplePoints, LAYER } from '../render/renderer.js';
import { buildRig, fileAnimations } from './anim.js';

export async function createJob(name, bytes, warn) {
  let job;
  if (/\.obj$/i.test(name)) {
    const root = new OBJLoader().parse(new TextDecoder().decode(bytes));
    root.traverse((o) => {
      if (!o.isMesh) return;
      const hasColor = !!o.geometry.attributes.color;
      o.material = new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xb8bcc8, roughness: 0.6, vertexColors: hasColor });
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      o.castShadow = o.receiveShadow = true;
    });
    job = { root, vfx: [], lights: [], highlights: [], hlGroup: null, rig: null, animations: [] };
  } else {
    const tree = parseModel(bytes);
    job = await buildScene(tree, warn);
    job.rig = buildRig(tree, job.partObjects, job.skinned);
    job.animations = job.rig ? fileAnimations(tree) : [];
  }
  job.points = samplePoints(job.root);
  if (!job.points.length) warn('Nothing visible to render in this file');
  job.vfxSystem = null;
  job.poseTrack = null;
  job.poseTime = 0;
  job.vfxGroup = null;
  if (job.vfx.length) {
    job.vfxSystem = await buildVfx(job.vfx, warn);
    job.vfxGroup = job.vfxSystem.group;
    job.vfxGroup.traverse((o) => o.layers.set(LAYER.VFX));
  }
  return job;
}

// Poses the rig (track null = pose saved in the file). Returns true when the pose changed.
export function setPose(job, track, time) {
  if (!job.rig) return false;
  const t = track ? time : 0;
  if (job.poseTrack === track && job.poseTime === t) return false;
  job.poseTrack = track;
  job.poseTime = t;
  job.rig.apply(track, time);
  job.root.updateMatrixWorld(true);
  job.hlGroup?.traverse((o) => { if (o.userData.src) o.matrix.copy(o.userData.src.matrixWorld); });
  job.points = samplePoints(job.root);
  return true;
}

// Re-simulates VFX at vfxSettings.time (cheap: no texture/geometry loading).
export function updateVfx(job, vfxSettings, poseChanged = false) {
  if (!job.vfxSystem) return;
  const { time, seed, includeBursts, maxParticles, prewarm, litLight } = vfxSettings;
  job.vfxSystem.update(time, { seed, includeBursts, maxParticles, prewarm, litLight }, poseChanged);
  job.vfxPoints = samplePoints(job.vfxGroup);
}
