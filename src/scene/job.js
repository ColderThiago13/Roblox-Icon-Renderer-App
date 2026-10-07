// A "job" is everything the renderer needs for one file.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { parseModel } from '../rbx/model.js';
import { buildScene } from './build.js';
import { buildVfx } from './vfx.js';
import { buildTrails, attachmentSample } from './trails.js';
import { samplePoints, boundsOf, LAYER } from '../render/renderer.js';
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
    job = { root, vfx: [], trails: [], lights: [], highlights: [], hlGroup: null, rig: null, animations: [] };
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
  job.trailSystem = job.trails.length ? await buildTrails(job.trails, warn) : null;
  job.trailGroup = job.trailSystem?.group ?? null;
  job.trailGroup?.traverse((o) => o.layers.set(LAYER.TRAIL));
  return job;
}

// Sample motion from the selected animation, so scrubbing/export never depends on playback history.
export function updateTrails(job, settings) {
  if (!job.trailSystem || !settings.enabled || settings.length <= 0) {
    job.trailPoints = new Float32Array(); job.trailKey = null; return;
  }
  const key = JSON.stringify([settings, job.poseTime]);
  if (job.trailKey === key && job.trailTrack === job.poseTrack) return;
  const animated = settings.mode !== 'direction' && job.rig && job.poseTrack;
  let histories = null;
  if (animated) {
    const trails = job.trailSystem.trails;
    histories = new Map(trails.map(({ inst }) => [inst, []]));
    const groups = new Map();
    for (const { inst } of trails) {
      const duration = Math.min(Math.max(0, job.poseTime), Math.min(20, Math.max(0.01, inst.props.lifetime ?? 2)));
      if (!groups.has(duration)) groups.set(duration, []);
      groups.get(duration).push(inst);
    }
    try {
      // Group equal lifetimes, so short trails retain history even beside long-lived trails.
      for (const [duration, instances] of groups) {
        const steps = Math.max(1, Math.min(128, Math.ceil(duration * 60)));
        for (let i = 0; i <= steps; i++) {
          const age = duration * i / steps;
          job.rig.apply(job.poseTrack, job.poseTime - age, true);
          for (const inst of instances) histories.get(inst).push(attachmentSample(inst, age));
        }
      }
    } finally {
      job.rig.apply(job.poseTrack, job.poseTime, true);
      job.root.updateMatrixWorld(true);
    }
  } else if (settings.mode === 'animation') {
    histories = new Map(job.trailSystem.trails.map(({ inst }) => [inst, []]));
  }
  job.trailSystem.update(settings, histories, job.points?.length ? boundsOf(job.points).center : null);
  job.trailPoints = new Float32Array(job.trailSystem.trails.flatMap(({ mesh }) => mesh.geometry.userData.boundsPoints));
  job.trailKey = key; job.trailTrack = job.poseTrack;
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
