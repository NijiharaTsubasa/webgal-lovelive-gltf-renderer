import { IdlePose } from '../idle-pose.js';
import { createFixedBodyEvaluator } from './body-mapping.mjs';
import calibration from './body-calibration.js';

// Reuse the standard binding-space application, not a second retargeter.
export class ParameterBodyPose extends IdlePose {
  constructor(root, humanoidScale) {
    const evaluate = createFixedBodyEvaluator(calibration);
    const initial = evaluate(calibration.defaults);
    super(root, humanoidScale, { tracks: Object.entries(initial.rotations).map(([bone, rotation]) => ({
      bone, rotation, ...(bone === 'Hips' ? { translation: initial.hipsTranslation } : {}),
    })) });
    this.evaluate = evaluate;
  }
  applyParameters(parameters) {
    const pose = this.evaluate(parameters);
    for (const target of this.targets) {
      target.delta.fromArray(pose.rotations[target.node.name]);
      if (target.translation) target.translation.fromArray(pose.hipsTranslation);
    }
    this.apply();
  }
}
