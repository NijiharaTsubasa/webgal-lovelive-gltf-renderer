# glTF渲染器 for WebGAL_LoveLive 专版引擎

WebGAL_LoveLive 专版引擎的 glTF 浏览器渲染实现。包含模型加载、动作与表情播放、物理、参数动作、Shader、Behavior 和 WASM 依赖；不包含 WebGAL/Pixi 胶水层。

```js
import { OffscreenCharacter } from 'webgal-lovelive-gltf-renderer';
import { CharacterRenderer } from 'webgal-lovelive-gltf-renderer/character-renderer.js';
```

`OffscreenCharacter` 管理角色、固定构图、资源清单及预热；`CharacterRenderer` 供自行管理 Three 场景、相机、时钟的宿主使用。离屏入口类型见 `src/offscreen-character.d.ts`。

宿主可创建 `CharacterRenderSurface({ width, height })`，并通过 `OffscreenCharacter.create({ ...options, surface })` 让多个角色驻留同一个画布和 WebGL 上下文。角色分别持有场景与播放状态；同一 surface 每次只激活一个角色。准备其他角色前先 `surface.deactivate()`，准备完成后用 `surface.activate(actor)` 选择绘制对象，再调用角色更新并上传画布。`actor.dispose()` 释放角色资源；`surface.dispose()` 释放驻留角色及上下文。

创建选项 `meshClothEnabled` 控制网格布料，默认 `true`。设为 `false` 时保留骨骼弹簧物理；需要网格布料的实例在创建时启用该选项。

所有资源文件格式由`docs`中的文档定义。文档为 AI 所写，可能较为难以理解，由于作者本人对该领域不熟悉，仅能做到大方向把控，无余力润色文档，还请见谅。

## 生成式人工智能使用声明

本项目绝大多数代码与文档均由生成式人工智能（Generative AI）工具生成。核心路线和方案由作者与 AI 共同讨论确定。

但由于作者本人对该领域技术栈不熟悉，未对代码进行深度的代码审查或系统的测试，主要对最终呈现的功能效果进行验收，因此代码库可能存在较多技术债务与不规范之处。

如您在使用中遇到问题，或愿意帮助优化、重构底层代码，欢迎通过 Issue 或 Pull Request 参与共建。
