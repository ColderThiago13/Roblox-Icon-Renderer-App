// Keyframe sampling + easing sanity checks. Usage: node test/anim.test.js
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ease, sampleTrack, trackFromKeyframeSequence } from '../src/scene/anim.js';

const key = (t, x, style = 0, dir = 0) => ({ t, pos: new THREE.Vector3(x, 0, 0), quat: new THREE.Quaternion(), style, dir });
const track = { name: 't', length: 2, loop: true, curves: new Map([['Arm', [key(0, 0), key(1, 10, 1), key(2, 20)]]]) };
const x = (time) => new THREE.Vector3().setFromMatrixPosition(sampleTrack(track, 'Arm', time)).x;

assert.equal(x(0.5), 5);                    // linear between keys
assert.equal(x(1.5), 10);                   // Constant holds until the next key
assert.equal(x(2.5), 5);                    // looping wraps
assert.equal(sampleTrack(track, 'Leg', 1), null);
assert.equal(ease(5, 0, 0.5), 0.125);       // CubicV2 In
assert.equal(ease(3, 1, 0.5), 0.125);       // legacy Cubic: Out behaves like In
assert.ok(Math.abs(ease(5, 2, 0.5) - 0.5) < 1e-9);
// Weight-0 placeholder poses are not keys (they'd snap the joint back to rest)
{
  const pose = (name, x, weight, children = []) => ({ className: 'Pose', props: { name, weight, cframe: { p: [x, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] } }, children });
  const kf = (time, poses) => ({ className: 'Keyframe', props: { time }, children: poses });
  const ks = { className: 'KeyframeSequence', props: { name: 'w', loop: false }, children: [
    kf(0, [pose('Torso', 0, 1)]), kf(0.5, [pose('Torso', 0, 0, [pose('Arm', 1, 1)])]), kf(1, [pose('Torso', 10, 1)]) ] };
  const tr = trackFromKeyframeSequence(ks);
  assert.equal(tr.curves.get('Torso').length, 2);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(sampleTrack(tr, 'Torso', 0.5)).x, 5);
  assert.equal(tr.curves.get('Arm').length, 1);
}

console.log('anim ok');
