# 模型资源格式标准

本文定义 `model` 组件的清单字段、头身组合和 Behavior 声明。统一资源包的根结构见 [资源包规范](resource_package_spec.md)；GLB 的骨架、坐标、姿势和蒙皮要求见 [Humanoid 模型归一化标准](standardized_model_spec.md)；表情字段与控制语义见 [表情标准](model_expression_spec.md)。

## 1. 模型 `config.json`

模型条目位于[统一资源包清单](resource_package_spec.md)的 `components[]` 中。资源包内
保存清单引用的 GLB，路径可位于子目录；一份清单可以同时内聚模型和其他类型资源。

### 1.1 字段表

`components[]` 中的模型条目：

| 字段 | 类型 | 必需 | 约束与含义 |
|---|---|---|---|
| `type` | string | 必需 | 固定为 `model` |
| `name` | string | 必需 | 人类可读的模型名 |
| `description` | string | 可选 | 人类可读描述 |
| `group` | string | 条件必需 | head/body 组合兼容域；仅一体化模型可省略 |
| `motionGroup` | string | 可选 | 非空的模型族专属动作兼容域；只控制匹配动作的 `groupTracks` |
| `role` | string | 必需 | `integrated` / `head` / `body` 之一 |
| `model` | string | 必需 | GLB 相对 `config.json` 的路径；文件名不固定 |
| `morphPoses` | `MorphPose[]` | 条件必需 | `integrated` 与 `head` 必需；静态形变配方，可为空；`body` 不声明；详见[表情标准](model_expression_spec.md) |
| `expressionGroups` | `ExpressionGroup[]` | 条件必需 | `integrated` 与 `head` 必需；独立选择的表情分组，可为空；`body` 不声明；详见[表情标准](model_expression_spec.md) |
| `expressions` | `ExpressionPreset[]` | 条件必需 | `integrated` 与 `head` 必需；整体组合预设，可为空；`body` 不声明；详见[表情标准](model_expression_spec.md) |
| `defaultExpression` | string | 可选 | 引用 `expressions` 中的整体预设；省略时各组选择其第一个状态 |
| `defaultMotion` | string | 可选 | 默认展示的动作清单 `name`；可用时按该动作自身的程序播放 |
| `idlePose` | object | 可选 | 无动作时展示的单帧标准 Humanoid 姿态；见 §1.5 |
| `humanoidScale` | number | 必需 | 当前 GLB 的静态人体尺度，必须为正有限数；供标准动作恢复 `Hips` 位移 |
| `behaviors` | `BehaviorDeclaration[]` | 可选 | 当前组件声明的模型运行时 Behavior 及其参数；见 §1.8 |
| `physics` | object | 可选 | 辅助骨、布面及碰撞体配置；见[模型物理字段标准](model_physics_spec.md) |

每个 GLB 各自保留 `humanoidScale`，同目录不同条目的值不要求相同。组合播放动作时采用 body 条目的值；head 条目的值可供独立检查、资产聚合或其他调用方使用。

### 1.2 模型清单与 `role`

每个模型条目的 `type` 固定为 `model`，并通过 `role` 声明用途：

| `role` | 含义 | 携带表情控件 |
|---|---|---|
| `integrated` | 可独立加载的一体化角色 | 是 |
| `head` | 可组合头部 | 是 |
| `body` | 可组合身体及权威 Humanoid 骨架 | 否 |

同一清单中不得出现重复的 `name + role` 身份。
不同模型以及其他资源类型可以共存于同一清单。目录聚合只是便于复制和
分发，不把其中的 head/body 固定配对；应用仍可任意组合同 `group` 的 head × body。

### 1.3 `group` 字段

模型条目的 `group` 字段（string）定义 head/body 的**组合兼容域**。`head` 或
`body` 条目必须填写；`integrated` 条目可以省略。只有 `group` 完全相同的 head 与
body 才允许组合；跨 `group` 的组合必须在加载前被拒绝。

互不兼容的头身资源必须使用不同 `group` 值；
`group` 不表示动作兼容性，也不要求按来源划分。

### 1.4 `motionGroup` 字段

模型条目的 `motionGroup` 字段（string，可选）定义模型族专属动作轨道的兼容域。
它与动作清单条目的同名字段比较，也用于匹配
[参数驱动动作与表情扩展](parameter_driven_animation_spec.md)中的面部适配器。
它不参与 head/body 组合判定，也不改变标准 Humanoid 骨骼动作的跨来源兼容性。

模型与动作的 `motionGroup` 都存在且完全相同时，播放器可以应用动作 Clip 中的 `groupTracks`；任一侧缺失或值不同时，播放器忽略 `groupTracks`，但仍正常播放标准 Humanoid 轨道。

分体模型组合后的有效 `motionGroup` 按以下规则确定：head 与 body 都声明且值完全相同时使用该值；否则组合结果不具备 `motionGroup`。因此，头身组合域与专属动作兼容域可以具有不同范围。

### 1.5 默认展示姿态

模型可声明 `defaultMotion` 和 `idlePose`。显示时优先播放可用的默认动作；未找到该动作时显示 `idlePose`；两者都不可用时显示 GLB 的标准中性姿势。下游应用仍可显式选择其他动作或静止姿态。`defaultMotion` 只按动作清单的 `name` 引用。

`idlePose.tracks` 是非空的单帧标准骨骼轨道列表。每项含标准 Humanoid `bone` 和四元数 `rotation: [x,y,z,w]`；只有 `Hips` 可另含 `translation: [x,y,z]`。数值语义与[标准动作](standardized_motion_spec.md) §1.2、§2.1–2.2 相同：旋转是相对模型 zero-muscle 中性局部旋转的增量，Hips 位移是经人体尺度归一化的模型空间增量。缺少可选骨时跳过对应轨道。

```json
{
  "defaultMotion": "idle",
  "idlePose": {
    "tracks": [
      { "bone": "Hips", "rotation": [0, 0, 0, 1], "translation": [0, 0, 0] },
      { "bone": "Spine", "rotation": [0, 0, 0, 1] }
    ]
  }
}
```

静止姿态只影响显示；模型 GLB 和动作播放器的参考姿势仍是[归一化标准](standardized_model_spec.md)定义的中性姿势。分体模型取 body 的默认动作与静止姿态。来源若使用 Unity Humanoid muscle，静止姿态也必须由 Unity 解算并转换，不得自行推算。

### 1.6 示例（一体化与分体模型）

```json
{
  "components": [
    {
      "type": "model",
      "name": "model_name",
      "description": "Human-readable description",
      "motionGroup": "example-family",
      "role": "integrated",
      "model": "model.glb",
      "morphPoses": [],
      "expressionGroups": [],
      "expressions": [],
      "humanoidScale": 0.9
    }
  ]
}
```

分体模型可以在一个目录内同时携带 `head.glb` 与 `body.glb`：

```json
{
  "components": [
    {
      "type": "model",
      "name": "model_name",
      "group": "example-compatible-rig",
      "motionGroup": "example-family",
      "role": "head",
      "model": "head.glb",
      "morphPoses": [],
      "expressionGroups": [],
      "expressions": [],
      "humanoidScale": 1.52
    },
    {
      "type": "model",
      "name": "model_name",
      "group": "example-compatible-rig",
      "motionGroup": "example-family",
      "role": "body",
      "model": "body.glb",
      "humanoidScale": 1.48
    }
  ]
}
```

### 1.7 头身组合的结果要求

`head` 与 `body` 的 `group` 必须相同，否则不能组合。组合后以 body 的标准
Humanoid 核心骨为唯一权威骨架；head 蒙皮引用的核心骨按[归一化标准](standardized_model_spec.md)
§2 映射到 body 的同名骨。body 缺少允许缺失的可选骨时，映射到最近的现存标准祖先骨，
并保持中性外观；没有可用祖先时不能组合。零权重 joint 仍须保持引用有效，但不表示
顶点实际依赖该骨。

head 独有的非核心骨与网格须保持中性姿势下的世界外观，并跟随相应的 body 骨运动；
组合后的逆绑定关系须对应最终骨架，不能直接把另一骨架的矩阵当成有效结果。
最终参与绘制和动作寻址的核心骨名称须唯一，不能由并列双骨架或逐帧复制同名骨来
维持组合。

组合角色使用 head 的[表情定义](model_expression_spec.md)，按 §1.8 汇总并启动
Behavior 后建立动作参考姿势；物理等扩展中的核心骨引用也指向同一权威骨架。
有效 `humanoidScale` 取 body，`motionGroup` 按 §1.4 确定。

### 1.8 模型运行时 Behavior 声明

#### 1.8.1 使用条件

模型运行时 Behavior 用于静态 glTF 无法完整表达的行为，包括跨
模型组件的数据合并、条件或非线性骨架计算、附件与辅助节点调整，以及必须在动作
求值前后执行的逐帧处理。

Behavior 不应仅为省略转换工作而引入，也不自动成为面向用户的控制项。

Behavior 包本身的目录、JavaScript 模块接口、生命周期及执行顺序由
[model_behavior_spec.md](model_behavior_spec.md) 规定。通用模型加载器只按完整名称
解析并驱动 Behavior，不解释其 `parameters`，也不根据游戏名称选择实现分支。

#### 1.8.2 `BehaviorDeclaration`

模型组件通过可选的 `behaviors` 数组声明 Behavior：

| 字段 | 类型 | 必需 | 约束与含义 |
|---|---|---|---|
| `name` | string | 必需 | Behavior 包注册的完整、区分大小写的行为名 |
| `required` | boolean | 必需 | Behavior 不可用时是否拒绝模型加载 |
| `parameters` | 任意 JSON 值 | 必需 | 当前模型组件传给 Behavior 的只读参数 |

示例：

```json
{
  "role": "head",
  "model": "head.glb",
  "behaviors": [
    {
      "name": "Example.AttachmentAdjuster",
      "required": false,
      "parameters": { "attachment": "accessory" }
    }
  ]
}
```

同一模型组件不得重复声明相同的 Behavior 名称。`parameters` 必须是合法 JSON，内部
结构和语义由模型转换器与对应 Behavior 共同约定；模型规范不合并对象、不解释字段，
也不使用其中内容进行实现分派。

模型清单只能按 `name` 引用宿主已经发现并注册的 Behavior，不能直接提供 JS 路径、
远程 URL 或内联代码。

#### 1.8.3 跨组件聚合

加载 `integrated` 模型或组合同 `group` 的 head/body 时，宿主汇总所选组件的全部
Behavior 声明并按完整名称归组。一个完整名称在一个最终模型中只创建一个 Behavior
实例。

同名声明的参数按来源角色分别传递：

```js
[
  { role: "head", parameters: headParameters },
  { role: "body", parameters: bodyParameters }
]
```

该数组只包含实际声明 Behavior 的组件。宿主不得生成缺失角色、合并 `parameters`
对象或根据数组位置猜测角色。`role` 只允许 §1.2 定义的 `head`、`body`、
`integrated`。

head/body 组合的同名声明数组长度为 `1` 或 `2`：只有实际声明该 Behavior 的角色
才出现；两者都声明时固定按 `head`、`body` 排列。integrated 模型的数组长度固定为
`1`，唯一一项使用 `role: "integrated"`。`integrated` 不得与 `head` 或 `body`
出现在同一个声明数组中。Behavior 必须读取 `role` 判断参数来源，不能只按数组长度
或位置猜测角色。

同名声明的有效 `required` 为所有声明值的逻辑或；任一组件声明 `true`，该 Behavior
对最终模型即为必需。Behavior 是否支持只有 head、只有 body 或 integrated 输入，
由其自身参数契约决定。

#### 1.8.4 缺失、冲突与执行失败

以下状态表示 Behavior 不可用：

- 没有发现对应完整名称；
- 多个 Behavior 包注册了相同完整名称；
- 对应脚本不存在、越出包目录或无法加载；
- JS 模块没有默认导出，或默认导出不可构造；
- 宿主没有 Behavior 运行时，或不能提供 Behavior 包规范要求的生命周期。

有效 `required` 为 `false` 时，宿主在不执行该 Behavior 的情况下继续加载模型。有效
`required` 为 `true` 时，Behavior 不可用必须拒绝模型加载。

`required` 只控制 Behavior 在执行前不可用的情况。一旦开始构造 Behavior，参数
校验、节点解析或生命周期方法抛出的异常均使当前模型实例失败；宿主不得吞掉异常后
继续使用可能已经被部分修改的实例。宿主可以丢弃该实例，并另行创建一个不启用可选
Behavior 的干净模型实例。

#### 1.8.5 与动作和人体尺度的顺序

规范顺序为：

1. 完成 §1.7 的 head/body 骨架组合，或建立 integrated 模型。
2. 汇总并启动 Behavior，完成其 `Awake`、`OnEnable` 和 `Start`。
3. 使用 Behavior 初始化后的最终状态建立动作播放器参考姿势。
4. 每帧在 Behavior `Update` 后求值标准动作，再调用 Behavior `LateUpdate`，最后渲染。

Behavior 可以通过标准运行时上下文更新有效 `humanoidScale`。同一最终模型最多一个
Behavior 可以写入该值；多个写入者必须拒绝加载。
