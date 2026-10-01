# 参数化渲染标准

本文定义 GLB 材质参数、Shader 资源和通用渲染器的接口。模型形变由 glTF、
[表情标准](model_expression_spec.md)或[模型 Behavior 规范](model_behavior_spec.md)承载。
渲染器按元数据解析 Shader、参数、纹理与 Pass，不根据来源或 Shader 名添加分支。

---

## 1. 模型组件：`components[].model` 指向的 GLB

`components[].model` 指向的文件是 glTF 2.0 Binary，文件名不固定。自定义 Shader
相关元数据放在 `material.extras`。

### 1.1 `material.extras` 字段一览

只有带 custom shader 的材质才会有 extras；标准 PBR 材质保持空 extras 或无 extras。

| 字段 | 类型 | 必需 | 含义 |
|------|------|------|------|
| `shader` | string | **必需** | shader 名（与资源清单中 `type: shader` 条目的 `name` 对齐） |
| `programCacheKey` | string | 可选 | 引擎 program 缓存 key；同一 `shader` 下不同材质不应共享 |
| `textures` | object | 可选 | 材质实际提供的 texture slot 名 → glTF texture index（`sampler2D`）或按层顺序排列的非空 index 数组（`sampler2DArray`）。slot 名是 shader 的 sampler 名（去掉 `u` 前缀） |
| `shaderParams` | object | 可选 | shader uniform 参数（键 = uniform 名去掉 `u` 前缀，值 = number / vec2/3/4） |
| `renderState` | object | 可选 | 通用渲染状态（见 §1.4） |
| `passes` | array | **必需** | 本 Material 提供的 Pass 及默认执行顺序（见 §1.3） |

不带自定义 Shader 的材质不需要这些字段。

### 1.2 字段约束

**`shaderParams` 值的类型由结构推断**：

| JSON | 推断 GLSL 类型 |
|------|---------------|
| number | float |
| `[x, y]` | vec2 |
| `[x, y, z]` | vec3 |
| `[x, y, z, w]` | vec4 |

数组元素数决定推断类型，必须与目标 GLSL uniform 的声明一致；不能通过补零或补一
改变类型。

`textures` 按 slot 名查找，本身没有顺序要求。渲染器按 `samplers[].name` 对应
GLSL uniform 绑定，不假设特定纹理单元编号或声明顺序。

`textures` 引用的每个 glTF texture 必须在 `texture.extras.colorSpace` 中显式声明采样颜色空间，取值只能是 `"srgb"` 或 `"linear"`。转换器应从源资产纹理元数据保留该语义；渲染端在绑定 custom-shader sampler 前必须应用它。字段缺失或取值未知时必须报告错误，不能依赖宿主引擎按纹理用途猜测。此字段描述纹理样本的解码方式，不改变 `shaderParams` 中数值和颜色 uniform 的线性值约定。

`sampler2DArray` 的 slot 值按索引数组顺序对应 GLSL 层号 0、1、……。每层都是普通 glTF texture；层数必须非零，各层尺寸、颜色空间和采样设置必须一致。渲染端按层顺序组装二维数组纹理，不能改用二维 atlas 或只取首层。索引非法、层数据不一致或宿主不支持数组纹理时必须报错。`sampler2D` 仍只接受单个索引，数组值不得自动降级。

### 1.3 `passes[]`

每个 custom-shader Material 必须声明一个非空 `passes` 数组；单 Pass 材质也必须显式
声明。数组内 `id` 不得重复，且必须引用对应 Shader 条目已经定义的 Pass。Shader 定义
但 Material 未声明的 Pass，表示该 Material 不提供它。

```json
{
  "shader": "ExampleToon",
  "shaderParams": { "MainColor": [1, 1, 1, 1] },
  "textures": { "MainTex": 0 },
  "renderState": { "zWrite": 1 },
  "passes": [
    { "id": "Forward" },
    {
      "id": "Outline",
      "shaderParams": {
        "OutlineWidth": 0.003,
        "OutlineColor": [0, 0, 0, 1]
      },
      "renderState": { "cull": 1 }
    }
  ]
}
```

| 字段 | 必需 | 含义 |
|------|------|------|
| `id` | 是 | 对应 Shader 条目中的 Pass ID |
| `shaderParams` | 否 | 当前 Pass 的参数覆盖 |
| `textures` | 否 | 当前 Pass 的纹理覆盖 |
| `renderState` | 否 | 当前 Pass 的固定状态覆盖 |
| `extras` | 否 | 携带 Pass 私有元数据；本规范不解释其内容 |

Material 不提供某个 Pass 时，直接省略对应条目。

顶层 `shaderParams`、`textures` 和 `renderState` 是所有声明 Pass 的公共值。
`shaderParams` 与 `textures` 按键浅合并，Pass 同名键覆盖顶层值。`renderState` 按字段
合并，其中 `blend`、`stencil`、`offset` 继续按叶子字段合并。合并顺序为：

```text
Shader Pass 默认 renderState
→ Material 顶层 renderState
→ Material Pass renderState
```

`null` 不表示删除继承值，任何层出现 `null` 都必须报错。

`renderQueue` 描述整个 Material 绘制项在场景中的队列，只允许出现在 Material 顶层
`renderState`；Shader Pass 默认值和 Material Pass 覆盖均不得声明它。

`passes[]` 的数组顺序是 Material 的默认 Pass 执行顺序。没有其他执行计划介入时，
通用渲染器按此顺序执行全部声明 Pass。上层渲染配置可以消费 Pass ID，提供选择、重排
或分阶段执行等其他计划；上层配置的格式和调度语义不在本文定义。

### 1.4 `renderState` 子字段

通用渲染状态与具体 Shader 无关；字段语义和枚举值如下。渲染器将其映射到宿主引擎的等价状态。

所有字段均可选。字段缺省表示没有覆盖该状态，保留较低优先级的值；各层均未声明时
使用宿主材质的基础状态。渲染器不得把缺省误认为该字段已显式设置。

| 字段 | JSON 类型 | 含义 |
|------|-----------|------|
| `surfaceType` | number (0/1) | 表面类型：0=Opaque, 1=Transparent |
| `cull` | number (0/1/2) | 裁剪模式：0=Off, 1=Front, 2=Back |
| `zWrite` | number (0/1) | 深度写入开关：0=Off, 1=On |
| `zTest` | number | 深度测试函数枚举（0=Disabled） |
| `colorMask` | number (0..15) | 颜色写入通道掩码 |
| `renderQueue` | number | 绘制队列优先级（如 2000, 3000） |
| `alphaToMask` | number (0/1) | MSAA alpha-to-coverage 开关：0=Off, 1=On |
| `offset` | object | 多边形偏移，包含 `factor` 和 `units` |
| `blend` | object | 混合状态，包含 `srcRgb`, `dstRgb`, `srcAlpha`, `dstAlpha`, `opRgb`, `opAlpha` |
| `stencil` | object | 模板状态，包含 `ref`, `readMask`, `writeMask`, `comp`, `pass`, `fail`, `zFail` |

枚举数值约定（与 Unity Shader 关键字一致）：

- `cull`: 0=Off, 1=Front, 2=Back
- `zTest`: 借用 Unity `CompareFunction` 数值（0=Disabled, 1=Never, 2=Less, 3=Equal, 4=LessEqual, 5=Greater, 6=NotEqual, 7=GreaterEqual, 8=Always）
- `blend.srcRgb/dstRgb/srcAlpha/dstAlpha`: 借用 Unity `BlendMode` 数值（0=Zero, 1=One, 2=DstColor, 3=SrcColor, 4=OneMinusDstColor, 5=SrcAlpha, 6=OneMinusSrcColor, 7=DstAlpha, 8=OneMinusDstAlpha, 9=SrcAlphaSaturate, 10=OneMinusSrcAlpha）
- `blend.opRgb/opAlpha`: 借用 Unity `BlendOp` 数值（0=Add, 1=Subtract, 2=ReverseSubtract, 3=Min, 4=Max）
- `stencil.comp`: 同 `zTest`
- `stencil.pass/fail/zFail`: 借用 Unity `StencilOp` 数值（0=Keep, 1=Zero, 2=Replace, 3=IncrementSaturate, 4=DecrementSaturate, 5=Invert, 6=IncrementWrap, 7=DecrementWrap）
- `colorMask`: 借用 Unity `ColorWriteMask` 位标志：`0=None, 1=Alpha, 2=Blue, 4=Green, 8=Red, 15=All`。其他取值按位或组合（`3=Blue|Alpha, 5=Green|Alpha, 6=Green|Blue, 7=Green|Blue|Alpha, 9=Red|Alpha, 10=Red|Blue, 11=Red|Blue|Alpha, 12=Red|Green, 13=Red|Green|Alpha, 14=Red|Green|Blue`）。

某些宿主引擎的绘制队列属于对象而非材质；此时，同一绘制对象上的不同材质队列
需要由适配层拆分绘制对象，不能静默忽略其中一个队列。

---

## 2. Shader 资源

Shader 条目位于[统一资源包清单](resource_package_spec.md)的 `components[]` 中。同一个
自包含目录可以声明多个 Shader，也可以与模型、动作或其他资源一起交付；渲染端按
Shader 的 `name` 索引，不按目录名推断身份。

### 2.1 文件清单

目录与路径规则见[统一资源包规范](resource_package_spec.md)。Shader 文件可以平铺
在清单旁，如 `"src": "toon.glsl"`，也可以位于子目录，如
`"src": "effects/highlight.glsl"`；同一包可以混用，目录不决定 Shader 身份。

Shader 条目只描述自身。可选的 JS 模块按 §2.5 的接口契约提供。

### 2.2 Shader 条目

| 字段 | 类型 | 必需 | 含义 |
|------|------|------|------|
| `type` | string | 必需 | 固定 `"shader"` |
| `name` | string | 必需 | Shader 名（与 `material.extras.shader` 对齐，跨语言同形） |
| `description` | string | 可选 | 人类可读描述 |
| `src` | string | 必需 | GLSL 源文件路径（相对所在 `config.json`） |
| `samplers` | `SamplerDescriptor[]` | 必需 | 材质纹理 sampler 描述符列表；各项按 `name` 对应 GLSL uniform |
| `script` | string | 可选 | Shader 运行时 JS 模块路径（相对所在 `config.json`）。详见 §2.5；无此字段表示不需要 JS 运行时 |
| `passes` | array | **必需** | 该 Shader 定义的非空 Pass 列表 |

所有已加载资源中的 Shader `name` 必须唯一；冲突时不得按扫描顺序覆盖。

每个 Shader 条目的 `passes[].id` 必须唯一。Pass 条目包含：

| 字段 | 必需 | 含义 |
|------|------|------|
| `id` | 是 | Pass 的唯一标识；Material 必须使用它引用 Pass，上层渲染配置也可以消费该标识 |
| `sections` | 是 | 标准注入位置到 GLSL section 名的映射 |
| `renderState` | 否 | 该 Pass 的默认固定状态 |

`sections` 的值可以是一个 section 名，也可以是非空 section 名数组。数组用于同一注入
位置复用公共代码并追加 Pass 私有代码，按数组顺序拼接。引用不存在的 section、未知
注入位置和重复 Pass ID 都必须在加载时报告错误。

以下是一个 Shader 条目示例；完整 `config.json` 仍按统一资源包规范放在
`components[]` 中：

```json
{
  "type": "shader",
  "name": "ExampleToon",
  "src": "shader.glsl",
  "samplers": [],
  "script": "runtime.js",
  "passes": [
    {
      "id": "Forward",
      "sections": {
        "vertexPrelude": "COMMON_VERTEX_PRELUDE",
        "fragmentPrelude": "COMMON_FRAGMENT_PRELUDE",
        "fragmentBody": "FORWARD_FRAGMENT_BODY"
      }
    },
    {
      "id": "Outline",
      "sections": {
        "vertexPrelude": ["COMMON_VERTEX_PRELUDE", "OUTLINE_VERTEX_PRELUDE"],
        "vertexInject": "OUTLINE_VERTEX_INJECT",
        "fragmentPrelude": ["COMMON_FRAGMENT_PRELUDE", "OUTLINE_FRAGMENT_PRELUDE"],
        "fragmentBody": "OUTLINE_FRAGMENT_BODY"
      },
      "renderState": { "cull": 1, "zWrite": 1 }
    }
  ]
}
```

#### `SamplerDescriptor`

```json
{
  "name": "NormalTex",
  "type": "sampler2D",
  "missing": {
    "behavior": "constant",
    "value": [0.5, 0.5, 1.0, 1.0]
  }
}
```

| 字段 | 类型 | 必需 | 含义 |
|------|------|------|------|
| `name` | string | 必需 | sampler 名，不包含 uniform 的 `u` 前缀 |
| `type` | string | 必需 | GLSL sampler 类型：`sampler2D` 或 `sampler2DArray` |
| `missing` | object | 必需 | 模型材质未提供该纹理时的绑定行为 |

`name` 在同一个 Shader 条目的 `samplers` 中必须唯一。`name` 和 `type` 必须与该 Shader 源文件中对应的 `u<name>` uniform 一致。`samplers` 是该 Shader 所有 Pass 共享的描述符全集。

#### sampler 缺失行为

当 `material.extras.textures` 中不存在对应 slot 时，渲染端执行 `missing.behavior`。支持以下行为：

| `behavior` | 附加字段 | 含义 |
|------------|----------|------|
| `error` | 无 | 纹理缺失时报告错误 |
| `constant` | `value` | 绑定返回指定恒定采样值的纹理 |
| `resource` | `uri`, `colorSpace` | 绑定 shader 包内指定的纹理资源；`colorSpace` 必须是 `"srgb"` 或 `"linear"` |

每个 sampler 必须显式声明 `missing`，不存在全局缺失行为。
`sampler2DArray` 支持 `error` 和 `constant`；`resource` 仅支持 `sampler2D`。不支持的类型与缺失行为组合必须在加载时报告错误。

`constant.value` 表示 shader 采样该纹理时应得到的值。对于普通浮点 RGBA sampler，值为四元素数值数组：

```json
{
  "behavior": "constant",
  "value": [1.0, 1.0, 1.0, 1.0]
}
```

渲染端必须创建与 sampler 类型兼容的纹理，使其采样结果等价于 `value`。无法为声明的 sampler 类型实现该采样值时，必须报告错误。

`resource.uri` 是相对于当前 shader 包目录的资源路径：

```json
{
  "behavior": "resource",
  "uri": "defaults/lookup.png",
  "colorSpace": "linear"
}
```

该路径必须指向当前 shader 包内的资源。资源不存在、加载失败或类型不兼容时，必须报告错误。

纹理 slot 已声明但索引或引用无效、纹理读取或解码失败，均属于无效纹理，不适用 `missing`，必须报告错误。

### 2.3 `shader.glsl` 的 section 协议

源文件由 `// @section NAME ... // @end` 块切分。同一编译阶段的 section 共享 GLSL
声明空间；跨 vertex/fragment 的 varying 须保持声明与语义一致。

标准不解释 section 名，只规定以下注入位置。`FORWARD_*`、`OUTLINE_*`、
`ACCUMULATE_*` 等都只是 Shader 包自行选择的 section 名：

| 注入位置 | 注入规则 |
|----------|----------|
| `vertexPrelude` | prepend 到 vertex shader 顶部 |
| `vertexSkinNormal` | after `#include <skinnormal_vertex>` |
| `vertexSkinning` | after `#include <skinning_vertex>`，先于 `vertexInject` |
| `vertexInject` | after `#include <skinning_vertex>`，后于 `vertexSkinning` |
| `vertexProject` | after `#include <project_vertex>` |
| `fragmentPrelude` | prepend 到 fragment shader 顶部 |
| `fragmentFunctions` | before `void main()` |
| `fragmentAfterColor` | after `#include <color_fragment>` |
| `fragmentBody` | replace `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;` |

一个 Pass 只注入其 `sections` 显式引用的块；未引用的 section 不参与生成。
Pass ID 和 section 名均由 Shader 包定义，渲染器不按名称添加分支。

### 2.4 Section 编写要求

- 引用前面声明的 varying（PRELUDE）必须在 main 之前。
- 不能与 three.js MeshStandardMaterial 的命名冲突（避免覆盖内置 uniform）。
- 所有 sampler 用 `u<SlotName>` 命名（与 Shader 条目的 `samplers[].name` 一一对应）。
- 同一注入位置配置多个 section 时，按配置数组顺序一次性插入。

### 2.5 Shader 运行时（可选 JS 模块）

Shader 条目可以通过 `script` 字段挂一个 JS 模块，用于表达 shader 自身需要的 **渲染期副作用**（创建 / 写入 / 释放 GPU 资源、每帧渲染前插入截屏或后处理等）。这些副作用**属于 Shader 实现自身**，不由渲染端假设。

本 JS 契约明确与 Three.js 强绑定，不试图抽象跨引擎中间层。其他引擎可以读取相同模型参数与 GLSL 数据，但需要提供自己的 shader 包实现，不能直接复用这里的 JS。

**适用场景**（举例，仅用于说明契约覆盖范围）：

- shader 需要捕获不透明场景到自己管理的 RenderTarget（例如屏幕空间扭曲采样）
- shader 需要每帧在渲染前向材质 uniform 注入动态数据
- shader 自身持有 GPU 资源并负责其生命周期

每帧驱动 `uTime` / `uSceneLightColor` 等动态数据也可以由 shader JS 自行实现；渲染端只负责调用统一生命周期，不解释这些 uniform 的来源或语义。

#### 模块契约

`script` 指向的 JS 模块通过默认导出或具名导出提供一个或多个可构造的运行时类；
只有这些类参与运行时接口。每个类独立实例化并执行生命周期。表中方法均可选，
缺失时不执行对应操作：

| 方法 | 何时被调 | 职责 |
|------|---------|------|
| `constructor(THREE, renderer, material, mesh)` | 材质首次绑定时一次 | 接收引擎引用、渲染器、材质、mesh |
| `init(renderer)` | 构造后立刻 | 一次性创建 GPU 资源（RenderTarget、纹理等） |
| `getUniforms(passId, passMetadata)` | shader 编译时（onBeforeCompile 内） | 返回此运行时需要注入当前 Pass `shader.uniforms` 的字段。返回 `{ uniformKey: { value } }`；不区分 Pass 的实现可以忽略参数。 |
| `createPass(passId, material, mesh, passMetadata, resolvedTextures)` | 每个已声明 Pass 创建时一次 | 由 Shader JS 决定该 Pass 使用源 Mesh 的材质，还是创建附加 `Object3D`；需要自定义阴影／深度材质时也在此挂接。`resolvedTextures` 是当前 Pass 按 `samplers` 解析后的 `{ 槽名: THREE.Texture }`，只在运行时传入，不写入资源元数据。 |
| `onBeforeRender(renderer, scene, camera)` | 渲染前（每帧 1 次） | 渲染插入点；可读 scene/camera 作为上下文。是否可修改外部状态由 §2.5 约束条款约束 |
| `destroy()` | 运行时实例释放时 | 释放 GPU 资源，防止泄漏 |

#### 约束

- **JS 与 GLSL 强绑定**：JS 访问的 uniform 名（如 `getUniforms()` 返回的键）必须与 `shader.glsl` 声明一致；Shader 包作者自保证。
- **普通 Pass 不需要 JS**：没有任何运行时类接管某个 Pass 时，由通用渲染器完成普通材质 Pass 的绘制。
- **`createPass()` 只覆盖默认实现**：全屏对象、特殊挂接或额外资源生命周期不同于默认行为时，才由一个运行时类返回非空结果；其他类返回 `null` / `undefined`。多个非空结果必须报错。
- **返回传入的 `material`**：表示该 Pass 使用源 Mesh 的当前材质槽。多个 Pass 如需独立绘制，宿主须为其提供独立绘制项。
- **返回 `Object3D` 或非空 `Object3D[]`**：Shader JS 负责创建、挂接、逐帧同步和最终移除这些对象；渲染端登记 Pass ID、默认顺序及释放协调。不创建附加对象时返回 `null` / `undefined`，走默认 Pass 路径。
- **Pass 对象语义归 Shader JS**：克隆 Mesh、复用骨架、添加全屏 Mesh、更新动态 uniform 等行为不由通用渲染器根据 Pass 名推断。
- **附属绘制材质归 Shader JS**：原程序对 ShadowCaster、Depth 等管线有专用裁剪或顶点逻辑时，Shader JS 可用已解析纹理给 Mesh 挂接 `customDepthMaterial`／`customDistanceMaterial` 等 Three 材质，并在 `destroy()` 恢复原状态、释放自建材质；通用渲染器不根据 Shader 名实现这些公式。
- **临时状态须恢复**：运行时实例若修改外部 scene graph 或 renderer 状态，退出相关渲染阶段前必须恢复。

---

## 3. 渲染器实现

以下流程说明 Three.js 宿主如何按同一契约处理所有 Shader；JS 接口不承诺跨引擎复用。

### 3.1 一次性加载

枚举资源清单中的 `type: shader` 条目，按 `name` 建立唯一索引，校验 `samplers` 和
`passes`，并从该条目的 `src` 文件按 `// @section` 解析出 section。随后逐个验证每个
Pass 的注入位置及其引用的 section。

### 3.2 逐材质绑定

对模型每个 mesh 的每个 material：

1. `material.extras.shader` 缺失时，材质走宿主默认管线。
2. 按 `shader` 名找到 Shader 条目，并解析 Material 声明的 Pass；未知或重复 ID 报错。
3. 按 §1.3 合并每个 Pass 的参数、纹理和固定状态，只注入该 Pass 引用的 section。
   按名称绑定 sampler 和参数，并合并 Shader JS 提供的动态 uniform。
4. 每个 Pass 必须有独立的有效材质状态和 Shader 程序缓存身份，不得因缓存复用而套用
   另一个 Pass 的 section 或固定状态。Three.js 宿主可用独立 Material 和包含 Shader、
   源材质及 Pass 身份的 program cache key 实现。
5. 有 `script` 时按 §2.5 创建运行时实例、调用其可选生命周期并释放其资源；没有
   `createPass()` 接管时执行普通材质 Pass。
6. 没有其他执行计划介入时，按 Material `passes[]` 顺序执行全部声明 Pass。上层渲染
   配置可以消费 Pass ID 并提供其他执行计划；其格式和调度语义不在本文定义。

整条路径对所有 shader 一致——**渲染代码不应按 `extras.shader` 的字符串值特判**。

### 3.3 边界

动态 uniform、RenderTarget 和全局输入由 Shader JS 或宿主场景提供，不写入材质的
静态参数表。跨对象渲染阶段和 Pass 选择可由上层渲染配置负责；本文不定义其格式。
Shader 私有的逐 Pass 数据可放在 `passes[].extras`，通用渲染器不解释内容。
