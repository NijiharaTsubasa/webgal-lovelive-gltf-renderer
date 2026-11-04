# glTF渲染器 for WebGAL_LoveLive 专版引擎

WebGAL_LoveLive 专版引擎的 glTF 浏览器渲染实现。包含模型加载、动作与表情播放、物理、参数动作、Shader、Behavior 和 WASM 依赖；不包含 WebGAL/Pixi 胶水层。

```js
import { OffscreenCharacter } from 'webgal-lovelive-gltf-renderer';
import { CharacterRenderer } from 'webgal-lovelive-gltf-renderer/character-renderer.js';
```

`OffscreenCharacter` 管理角色、固定构图、资源清单及预热；`CharacterRenderer` 供自行管理 Three 场景、相机、时钟的宿主使用。离屏入口类型见 `src/offscreen-character.d.ts`。

宿主可创建 `CharacterRenderSurface({ width, height })`，并通过 `OffscreenCharacter.create({ ...options, surface })` 让多个角色驻留同一个画布和 WebGL 上下文。角色分别持有场景与播放状态；同一 surface 每次只激活一个角色。准备其他角色前先 `surface.deactivate()`，准备完成后用 `surface.activate(actor)` 选择绘制对象，再调用角色更新并上传画布。`actor.dispose()` 释放角色资源；`surface.dispose()` 释放驻留角色及上下文。

创建选项 `meshClothEnabled` 控制网格布料，默认 `true`。设为 `false` 时保留骨骼弹簧物理；需要网格布料的实例在创建时启用该选项。

网格布料只模拟一组稀疏的代理粒子，活动区的渲染顶点按权重跟随代理的平均蒙皮与模拟位移（与 Magica Cloth 的代理网格相同），同一组粒子上的里外层布料始终一起运动；声明为固定的顶点严格跟随原动画。模型声明了来源代理划分（`physics.cloths[].proxy`）时按其分组，否则按空间距离自动划分；空间上重叠或相邻的分片、内衬会合并到同一组粒子上一起运动。模拟可能把原本只渲染正面的布片翻向镜头；被模拟的布料网格主 pass 会同时绘制背面，翻出的内侧显示为面料颜色，而不是被反向外壳描边 pass 填成描边色。渲染顶点相对代理面的偏移（褶子深度、内衬间距）随代理邻域的旋转一起转动，布料甩离动画姿态时里外层仍保持叠放顺序。碰撞除模型声明的胶囊体外，还使用角色自身的蒙皮表面：加载时取胶囊体附近的皮肤、袜子、鞋等网格顶点（排除布料本身，以及静止姿态下已被布料覆盖或穿插的部分，保留原作的层叠关系），每帧蒙皮后补上胶囊体没有覆盖到的凸出部分；比代理粒子间距细的肢体（小腿、脚、手臂）还会检查粒子之间的边，避免从两个粒子之间穿过布面。

模型纹理支持 PNG 和 `KHR_texture_basisu` 的 KTX2/UASTC。加载时根据 WebGL 能力转码为 GPU 支持的压缩格式，无可用格式时使用 RGBA。转码器 JS 和 WASM 随本包提供，Vite 构建会将其发布为资源文件。使用默认加载器的角色共享转码 Worker，最后一个使用者释放后回收；自行注入 GLTFLoader 的宿主需自行配置 KTX2Loader。

所有资源文件格式由`docs`中的文档定义。文档为 AI 所写，可能较为难以理解，由于作者本人对该领域不熟悉，仅能做到大方向把控，无余力润色文档，还请见谅。

## 生成式人工智能使用声明

本项目绝大多数代码与文档均由生成式人工智能（Generative AI）工具生成。核心路线和方案由作者与 AI 共同讨论确定。

但由于作者本人对该领域技术栈不熟悉，未对代码进行深度的代码审查或系统的测试，主要对最终呈现的功能效果进行验收，因此代码库可能存在较多技术债务与不规范之处。

如您在使用中遇到问题，或愿意帮助优化、重构底层代码，欢迎通过 Issue 或 Pull Request 参与共建。
