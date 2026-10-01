/*!
 * Expression normalization/blending adapted from pixi-live2d-display-webgal
 * 0.5.12, based on https://github.com/guansss/pixi-live2d-display.
 * MIT License
 * Copyright (c) 2020 Guan
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// This is the readable, MIT-licensed high-level expression policy.
// The injected runtime owns AMotion fading and queues.
export function createWebgalExpression(runtime, json) {
  const params = (Array.isArray(json.params) ? json.params : []).map(param => {
    let value = param.val;
    const calc = param.calc || 'add';
    if (calc === 'add') value -= param.def || 0;
    else if (calc === 'mult') value /= param.def || 1;
    if (typeof param.id !== 'string' || !param.id || !Number.isFinite(value)) throw new Error('EXP 参数必须包含 id 与有限数值');
    return { id: param.id, value };
  });
  return new class extends runtime.AMotion {
    constructor() {
      super(); this.setFadeIn(json.fade_in > 0 ? json.fade_in : 500);
      this.setFadeOut(json.fade_out > 0 ? json.fade_out : 500);
    }
    updateParamExe(model, time, weight) {
      for (const { id, value } of params) {
        model.setParamFloat(id, value * weight + model.getParamFloat(id) * (1 - weight));
      }
    }
  }();
}
