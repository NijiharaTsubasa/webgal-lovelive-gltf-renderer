# 模型运行时 Behavior 包规范

> 本文规定模型运行时 Behavior 包的自包含目录、发现方式、JavaScript
> 模块接口和生命周期。模型 `config.json` 如何引用 Behavior、如何在
> `head` / `body` 间传递参数，以及缺少 Behavior 时的模型加载规则，由
> [model_package_spec.md](model_package_spec.md) §1.8 规定。

## 1. 目标与边界

Behavior 包承载不能完整表达为静态 glTF 的模型运行时行为，
包括跨模型组件的数据合并、条件或非线性骨架计算、附件与辅助节点调整，以及
必须位于动作求值前后的逐帧处理。

本文的 JS 接口是 Three.js 模型运行时的扩展模块，允许直接使用 Three.js，
不定义跨渲染引擎的中间层。其他引擎可以读取相同的模型资源，但需要为所引用的
Behavior 提供对应实现。

Behavior 包中的 JavaScript 属于受信任的已安装运行时代码。模型清单只能按名称
引用宿主已经发现的 Behavior，不能提供远程 URL 或任意脚本路径。

## 2. 自包含目录

Behavior 条目位于[统一资源包清单](resource_package_spec.md)中。所在目录保存清单引用
的全部脚本和资源，并且可以同时内聚其他类型资源：

```text
resource-package/
├─ config.json
└─ behaviors/
   └─ attachment-adjuster.js
```

包内脚本可以引用同一包目录内的其他文件和资源。`config.json` 中的相对路径解析后
必须仍位于当前包目录内；绝对路径、远程 URL 和逃逸包目录的路径均为非法。

## 3. Behavior 清单条目

```json
{
  "components": [
    {
      "type": "behavior",
      "namespace": "Example",
      "name": "AttachmentAdjuster",
      "script": "behaviors/attachment-adjuster.js",
      "executionOrder": 0
    }
  ]
}
```

`components[]` 字段：

| 字段 | 类型 | 必需 | 约束与含义 |
|---|---|---|---|
| `type` | string | 必需 | 固定为 `behavior` |
| `namespace` | string | 必需 | 非空、区分大小写的行为命名空间 |
| `name` | string | 必需 | 当前 `namespace` 内非空且唯一的局部行为名 |
| `script` | string | 必需 | 默认导出 Behavior 类的 JS 模块相对路径 |
| `executionOrder` | integer | 可选 | 生命周期执行顺序；省略时为 `0`，较小值先执行 |

## 4. 名称与注册

Behavior 的完整名称由包命名空间和局部名称拼接：

```text
fullName = component.namespace + "." + component.name
```

名称区分大小写，不做自动规范化。`namespace` 可以由多个独立的自包含包共同使用；
例如两个包分别提供 `Example.AttachmentAdjuster` 与 `Example.SecondaryMotion` 是合法的。

所有已发现包产生的完整名称必须唯一。多个包产生同一个完整名称时，该名称处于
冲突状态，宿主不得根据扫描顺序任选、覆盖或合并实现。冲突只影响该完整名称，
不使其他无冲突的 Behavior 失效。模型引用冲突名称时按模型规范中的 `required`
规则处理。

`script` 必须解析为包内恰好一个可加载的 JS 模块。一个包可以包含多个 Behavior
及其共享的私有实现；一个游戏的 Behavior 也可以由多个使用相同 `namespace` 的包
分别提供。

## 5. JavaScript 模块接口

`script` 必须默认导出一个可构造类。宿主为每个模型实例中的完整 Behavior 名称
创建至多一个实例：

```js
export default class AttachmentAdjuster {
  constructor(context, declarations) {}

  Awake() {}
  OnEnable() {}
  Start() {}

  FixedUpdate() {}
  Update() {}
  LateUpdate() {}
  PostPhysics() {}

  OnDisable() {}
  OnDestroy() {}
}
```

生命周期方法均为可选方法。宿主只调用实例上存在且可调用的方法；其他方法名不属于
本文生命周期，不会被宿主自动调用。构造函数和生命周期方法抛出异常时，当前模型
实例进入失败状态，不得继续渲染或播放动作。

构造函数和所有生命周期方法必须同步完成，不得返回 `Promise` 或其他 thenable。
宿主检测到 thenable 返回值时，按 Behavior 执行失败处理。需要异步取得的数据必须
在模型加载与 Behavior 实例创建前由宿主准备完成，不能通过异步生命周期延后初始化。

回调名称和基本顺序与 Unity `MonoBehaviour` 一致，但本文不声明兼容 Unity 的完整
事件集合。碰撞、Trigger、IK、Animator root motion、Editor、GUI、协程、消息广播
和 Unity 特定渲染管线回调不属于本文接口。

## 6. 构造参数

构造函数接收：

```js
constructor(context, declarations)
```

`declarations` 是当前模型中同一个完整 Behavior 名称的角色参数列表：

```js
[
  { role: "head", parameters: headParameters },
  { role: "body", parameters: bodyParameters }
]
```

该数组只包含实际声明此 Behavior 的模型组件。宿主不生成缺失角色，不合并
`parameters`，也不解释其中字段。`declarations`、每项声明及其 `parameters`
均视为只读输入。

`role` 只允许模型规范定义的 `head`、`body`、`integrated`：

- head/body 组合中，`declarations` 长度为 `1` 或 `2`；只有实际声明该 Behavior 的
  角色才出现。两个角色都声明时固定按 `head`、`body` 排列。
- integrated 模型中，`declarations` 长度固定为 `1`，唯一一项的 `role` 为
  `integrated`。
- `integrated` 不得与 `head` 或 `body` 出现在同一个 `declarations` 数组中。

Behavior 必须按每项的 `role` 识别参数来源，不得只依据数组长度或位置猜测角色。

`context` 提供以下字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `THREE` | object | 宿主当前使用的 Three.js 模块 |
| `renderer` | `THREE.WebGLRenderer` | 当前渲染器 |
| `scene` | `THREE.Scene` | 当前场景 |
| `camera` | `THREE.Camera` | 当前相机 |
| `root` | `THREE.Object3D` | 已完成模型组件组合的最终模型根节点 |
| `parts` | array | 所选模型组件；每项结构见下文 |
| `time` | object | 当前 `deltaTime`、`fixedDeltaTime` 与 `elapsedTime` |
| `resolveNode` | function | 按来源 `role` 和原始 glTF `node.name` 精确解析当前运行时节点 |
| `getHumanoidScale` | function | 读取当前模型的有效 `humanoidScale` |
| `setHumanoidScale` | function | 写入 Behavior 求值后的有效 `humanoidScale` |
| `getExpressionDefinition(role)` | function | 读取指定组件的表情定义，见 §6.1 |
| `getExpressionState(role)` | function | 读取指定组件最近完成求值的表情状态，见 §6.1 |
| `getMotionDefinition()` | function | 读取当前模型实例所加载的动作定义，见 §6.2 |
| `getMotionState()` | function | 读取最近完成求值的动作状态，见 §6.2 |

`resolveNode(role, name)` 不进行大小写修正、模糊匹配、选取首项或祖先节点回退；
零命中和多命中均须报错。`setHumanoidScale(value)` 只接受正有限数。同一模型实例
中最多一个 Behavior 可以写入有效 `humanoidScale`，多个写入者属于冲突并使模型
加载失败。

`parts[]` 的公开字段为 `role`（组件角色）、`component`（对应清单条目）、
`gltf`（该组件的 glTF 加载结果）和 `root`（该组件的运行时根节点）。组合模型中的
`root` 仍指向该组件来源对象；需要按原始节点名取得组合后的有效节点时使用
`resolveNode(role, name)`，不要依赖宿主私有的节点索引。

Behavior 可以修改自己参数所引用的模型节点，也可以创建由自身管理的辅助对象。
它不得修改其他模型实例。Behavior 创建的场景对象、GPU 资源、定时器和事件订阅
必须由其 `OnDestroy` 释放。

### 6.1 表情查询

`role` 是当前模型实际存在的组件角色；非法或不存在的角色须报错。该组件没有
表情定义时，两个查询均返回 `null`。定义查询返回模型规范中的以下字段，保留
原定义的可选性，不包含模型、材质或 Behavior 配置：

```js
{ morphPoses, expressionGroups, defaultExpression }
```

状态查询在首次求值前返回 `null`，此后返回：

```js
{
  active: true,
  expression: { eye: "Sad", closed: "Smile", open: "A" }, // 低层控制时为 null
  selections: { eye: "Sad", closed: "Smile", open: "A" },
  blink: 0.3,
  speech: 0,
  visemes: null,                      // null 使用 speech；对象表示口型输入（可为空）
  rawWeights: null,                   // null 使用分组；对象表示低层配方输入（可为空）
  poseWeights: { "eye/Sad": 0.7, "eye/Close": 0.3, "mouth/Sad": 1 }
}
```

`selections`、blink/speech/visemes 是保存的输入；低层控制时它们不参与求值。
`poseWeights` 是按模型规范完成分组和控制映射后、展开到实际 Morph 之前的配方
系数；未出现的配方贡献为零。它不做裁剪或归一化，不能假定系数位于 `[0,1]`
或总和为 1。

`active:false` 表示表情系统已经撤去写入并释放控制权，此时 `poseWeights` 为
空对象，但保存的输入仍可查询。不能把动作写入的 Morph 反推为配方或预设。
Behavior 对已知配方的附带处理，以及对未知配方、负权重或停用状态的处理，
由该 Behavior 自身定义；通用宿主不解释配方名称。

### 6.2 动作查询

动作作用于组合后的整个模型实例，不按组件角色拆分。未加载动作时两个查询
均返回 `null`。定义在加载后可用；首次求值前状态为 `null`。

定义返回：

```js
{
  resource: { type: "motion", name, description, motionGroup },
  program, // 动作规范中的完整 Program：参数、命令、层、状态、过渡、姿势槽
  clips: [{
    id, duration, sampleRate, frames,
    tracks: [{ bone, rotation: true, translation: false }],
    groupTracks: [{ kind, node, property }]
  }]
}
```

`resource` 只返回清单中的上述字段，可选字段仍可省略。`clips` 汇总主 Clip、
辅助 Clip 和左右手姿势 Clip，以唯一 `id` 引用；不复制逐帧数组。`tracks`
的两个布尔值表示该轨道是否包含相应通道；`groupTracks` 保留目标描述。

状态返回：

```js
{
  parameters: { stop: false },
  layers: [{
    id: "Base Layer",
    state: "in", time: 1.1,
    transition: { to: "loop", elapsed: 0.1, duration: 0.25 },
    samples: [
      { state: "in", clip: "intro", time: 1, frame: 30, weight: 0.6 },
      { state: "loop", clip: "loop", time: 0.1, frame: 3, weight: 0.4 }
    ]
  }],
  poseSlots: [{ id: "left", selected: null, sample: null }],
  groupTracks: {
    matching: true, clip: "intro", time: 1, frame: 30,
    tracks: [{ kind: "morph", node: "face", property: "mouth_a" }]
  }
}
```

- `parameters` 是求值完成后的值，包括本帧已消费并复位的 trigger。
- `layers` 按 Program 顺序排列。`state` 在过渡中仍指来源状态；`time` 是其
  播放时钟秒数，不保证单调（循环可回绕）。无过渡时 `transition:null`，
  `samples` 只有一个权重为 1 的条目；过渡中按来源、目标顺序列出两个条目。
- sample 的 `time` 是经过循环/截断后的 Clip 采样秒数，`frame` 是实际阶梯
  采样帧。`weight` 仅是层内过渡系数；层权重和混合方式由 Program 查询。
  不能将它视为各骨骼的最终贡献：缺失通道、加算层和姿势槽仍遵循动作规范。
- `poseSlots` 按定义顺序排列，`selected` 为 option ID 或 `null`。启用时
  `sample` 为 `{clip,time,frame}`；姿势槽覆盖对应手指，不虚构一个混合权重。
- `groupTracks.matching` 表示模型和动作的非空 motionGroup 相等；`tracks`
  仅列出本帧实际写入的已解析专属轨道。专属轨道仍由基础层当前 Clip 独立求值，
  不因 Humanoid 正在过渡而报告两个混合来源。这里表示动作阶段的写入，后续
  表情或 Behavior 可能覆盖结果；未应用的轨道可与定义查询中的列表对照。

非循环 Clip 保持结束姿势时状态仍然存在；卸载动作后立即返回 `null`。动作
程序的 stop 命令不等同于卸载，查询应反映命令实际产生的状态变化。

### 6.3 只读与时序

四个查询返回只读普通数据，不暴露控制器、Three.js 对象、Map 或可变数组引用。
调用查询不推进播放、不触发求值；持有旧快照不会随新帧变化。资源定义可缓存，
运行状态不写回资源文件。

每次动作及表情求值全部完成后，宿主在任何 `LateUpdate` 前统一发布状态快照。
所有 Behavior 在同一阶段看到相同快照；`FixedUpdate` / `Update` 看到上一次
已完成的快照，尚未发生求值时看到 `null`。输入修改在下一次求值发布后可见，
不把新输入与旧输出混在一个状态中。暂停播放但重新求值表情也应先完成整轮
求值再发布。资源更换/卸载立即清除对应旧状态；销毁回调结束后清空全部查询。

查询只描述标准表情和动作系统，不推断场景节点变化的来源，也不把 Behavior
自己或 Shader JS 的写入伪装成标准动画状态。

## 7. 生命周期与执行顺序

宿主在模型加载阶段按以下顺序运行：

```text
加载模型组件
→ 完成 head/body 骨架组合，或建立 integrated 模型
→ 汇总并解析模型声明的 Behavior
→ 创建所有 Behavior 实例
→ 调用所有 Awake
→ 调用所有 OnEnable
→ 调用所有 Start
→ 以最终状态建立动作播放器和参考姿势
```

每帧按以下顺序运行：

```text
FixedUpdate（固定时间步，每帧执行零次或多次）
→ Update
→ Animator / 标准动作求值
→ 标准表情求值
→ 发布表情与动作查询快照
→ LateUpdate
→ 模型物理求值
→ PostPhysics
→ Render
```

销毁模型实例时按以下顺序运行：

```text
OnDisable
→ OnDestroy
→ 释放模型资源
```

同一生命周期阶段内，Behavior 按 `executionOrder` 从小到大执行；相同值之间的顺序
不作保证，需要明确先后关系时必须使用不同的值。宿主必须先完成所有实例的 `Awake`，
再开始任何实例的 `OnEnable`；同理，必须完成所有 `OnEnable` 后再开始任何 `Start`。

`context.time` 在调用逐帧方法前更新。`FixedUpdate` 使用 `fixedDeltaTime`；
`Update`、`LateUpdate` 与 `PostPhysics` 使用同一步的 `deltaTime` 和 `elapsedTime`。动作求值必须位于
`Update` 与 `LateUpdate` 之间，使行为可以在动画完成后执行跟随或补偿逻辑。

`PostPhysics` 用于在物理结果上执行补偿。未声明或关闭模型物理时仍调用此阶段。
补偿若修改受物理控制的辅助骨，物理求解器应同步更新对应状态，避免下一步跳回补偿前的结果；
下次动作求值仍从动画参考姿态开始，不将补偿永久累积进参考姿态。

当前资源格式不提供运行时启用或禁用 Behavior 的模型字段。成功创建的实例在模型
生命周期内保持启用，因此各调用一次 `OnEnable` 和 `OnDisable`。

## 8. 加载与运行错误

Behavior 包配置解析失败时，该包不注册任何定义。某个完整名称发生跨包冲突时，
该名称不可解析，其他无冲突名称仍可使用。脚本不存在、越出包目录、无法加载、没有
默认导出或默认导出不可构造时，对应完整名称不可用。宿主没有 Behavior 运行时，或
不能提供本文规定的生命周期时，所有 Behavior 名称均不可用。

模型引用不可用 Behavior 时，宿主按模型规范中声明的 `required` 决定拒绝模型或
在不执行该 Behavior 的情况下继续。该判断发生在构造 Behavior 之前，不存在部分
执行或回滚。

一旦宿主开始构造 Behavior，参数校验错误、节点解析错误和任一生命周期异常都属于
Behavior 执行失败，而非“Behavior 不可用”。执行失败使当前模型实例失效，与模型
声明的 `required` 值无关。宿主可以丢弃该实例，并另行创建一个不启用可选
Behavior 的干净模型实例；不得在原实例上吞掉异常后继续渲染。

## 9. 与 Shader 运行时的边界

Shader JS 依附于材质与渲染 Pass，Behavior 依附于模型实例并围绕动作求值执行；
两者分别发现和销毁。模型骨架行为不由通用渲染器按 Shader 名推断。
