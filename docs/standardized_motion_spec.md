# 标准动作包与参数化播放器规范

本文规定标准动作文件的字段、数值语义、存储编码和通用播放器行为。模型骨架、参考姿势和蒙皮须符合 [Humanoid 模型归一化标准](standardized_model_spec.md)；材质与 Shader 的参数化规则见 [参数化渲染标准](parameterized_rendering_spec.md)。

Behavior 可读取动作定义及已完成求值的运行状态，接口见
[model_behavior_spec.md](model_behavior_spec.md) §6.2、§6.3。查询不改变播放行为，
不将层内混合系数解释为最终骨骼权重，也不把运行状态写入资源文件。

来源适配器可以理解来源资源的结构和命名。标准动作正文通过显式 ID 和引用描述播放逻辑；播放器不得根据动作名、片段名、状态名、参数名或文件名推断语义，也不得包含针对某个游戏的分支。

动作保留来源参考 Avatar 经真实 Unity 解算后的骨骼运动，包括来源的扭转分配等解算设置。
标准化负责等价转换坐标和数据表达，不统一改写各来源的解算规则；目标模型直接播放已烘焙的
通用骨骼轨道，不再按目标游戏的 Avatar 设置重新解算，也不为每个目标模型另烘焙一套动作。

来源名称可以保留以便查看和检索；播放器只把它们当作普通标识符。

---

## 1. 标准动作文件

每个动作文件自包含其名称、描述、兼容域和全部播放数据。文件可采用纯 JSON 或
单文件二进制编码，两种编码任选其一，见 §1.4。元数据和播放数据位于同一根对象：

```json
{
  "type": "motion",
  "name": "motion_name",
  "description": "Human-readable description",
  "motionGroup": "example-family",
  "clips": [],
  "auxiliaryClips": [],
  "leftHandPoses": [],
  "rightHandPoses": [],
  "program": {}
}
```

动作元数据：

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `type` | string | 必需，固定为 `motion` |
| `name` | string | 必需，非空的人类可读动画名 |
| `description` | string，可选 | 人类可读描述；无描述时可省略或使用空字符串 |
| `motionGroup` | string，可选 | 非空的动作扩展兼容域；只控制 `groupTracks` 是否生效，不影响标准 Humanoid 轨道 |

`name` 保存来源动作的可读名称，与文件名及所在目录独立。应用根据资源路径或其
资源标识定位动作文件，加载后读取文件内的元数据与播放数据。

播放数据顶层字段：

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `clips` | `Clip[]` | 基础身体动作片段 |
| `auxiliaryClips` | `Clip[]` | Additive Layer 使用的增量片段 |
| `leftHandPoses` | `Clip[]` | 左手姿势片段 |
| `rightHandPoses` | `Clip[]` | 右手姿势片段 |
| `program` | `Program` | 参数、命令、Layer、状态机和姿势槽 |

四个片段数组共享同一个 ID 空间。所有 `Clip.id` 必须非空且在整个动作包内唯一。数组无内容时仍输出空数组。

动作和模型共同使用 glTF 右手坐标系：`+Y` 向上，`+Z` 向前，`+X` 向右；长度单位为米；四元数顺序为 `[x, y, z, w]`。骨名使用 `UnityEngine.HumanBodyBones` 枚举名称，不包含哨兵值 `LastBone`。

### 1.1 Clip

```json
{
  "id": "stand_enter",
  "name": "stand_enter",
  "duration": 0.8,
  "sampleRate": 30.0,
  "frames": 25,
  "tracks": [],
  "groupTracks": []
}
```

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `id` | string | 片段引用 ID；在四个片段数组间全局唯一 |
| `name` | string | 可读名称；播放器不据此推断播放语义 |
| `duration` | number | 片段时长，单位为秒，必须大于等于零 |
| `sampleRate` | number | 每秒采样数，必须大于零 |
| `frames` | integer | 固定为 `max(2, ceil(duration * sampleRate) + 1)` |
| `tracks` | `Track[]` | 按标准骨名组织的轨道 |
| `groupTracks` | `GroupTrack[]`，可选 | 与 `motionGroup` 对应的模型族专属轨道；省略等同于空数组 |

第 `i` 帧的烘焙时间为 `min(i / sampleRate, duration)`，所以最后一帧精确采样片段终点。标准采用阶梯采样：

```text
frame = min(frames - 1, floor(clipTime * sampleRate))
```

`id` 是机器引用，`name` 是展示名称。两者可以相同；播放器不得解析其中的前缀、后缀或编号。

### 1.2 Track

```json
{
  "bone": "Hips",
  "rotation": [0.0, 0.0, 0.0, 1.0],
  "translation": [0.0, 0.0, 0.0]
}
```

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `bone` | string | 一个有效的标准 Humanoid 骨名 |
| `rotation` | `number[]` | 长度为 `frames * 4`；每帧一个单位四元数 |
| `translation` | `number[]`，可选 | 只允许出现在 `Hips` 轨道，长度为 `frames * 3` |

同一片段内不得出现重复骨名。身体片段可省略来源 Avatar 不具备的可选骨轨道；目标模型也缺少该可选骨时，播放器跳过它。标准模型要求存在的骨缺失属于模型包错误。

`leftHandPoses` 和 `rightHandPoses` 是稀疏姿势片段，只应包含对应手部的手指骨。`auxiliaryClips` 中无增量的骨可以不输出。

### 1.3 GroupTrack

`GroupTrack` 保存不能归入标准 Humanoid 骨骼轨道、但仍属于动作本身的模型族专属动画。本格式定义 Morph Target、节点局部 TRS 和节点可见性三种轨道：

```json
[
  {
    "kind": "morph",
    "node": "face_Base_obj",
    "property": "mouth_a",
    "values": [0.0, 0.5, 1.0]
  },
  {
    "kind": "transform",
    "node": "accessory",
    "property": "localTRS",
    "translation": [0.0, 0.0, 0.0, 0.0, 0.01, 0.0, 0.0, 0.02, 0.0],
    "rotation": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
    "scale": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
  },
  {
    "kind": "visibility",
    "node": "accessory",
    "property": "visible",
    "values": [1.0, 0.0, 1.0]
  }
]
```

公共字段：

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `kind` | string | 必需，`morph`、`transform` 或 `visibility` |
| `node` | string | 必需，目标组件 GLB JSON 中非空、大小写敏感且唯一的原始 `node.name` |
| `property` | string | 必需；含义由 `kind` 决定 |

各类轨道的数据字段：

| `kind` | `property` | 数据字段 | 数值语义 |
|---|---|---|---|
| `morph` | Morph Target 名称 | `values: number[]`，长度为 `frames` | 每帧一个 Morph Target 权重；`1` 表示来源中的 100% 权重 |
| `transform` | 固定为 `localTRS` | `rotation: number[]` 必需，长度为 `frames * 4`；`translation`、`scale` 可选，存在时长度均为 `frames * 3` | 目标节点每帧的绝对局部 TRS；坐标系和四元数顺序与动作包一致 |
| `visibility` | 固定为 `visible` | `values: number[]`，长度为 `frames` | 值大于等于 `0.5` 时显示，否则隐藏 |

所有数组元素必须是有限数。`rotation` 每帧必须是单位四元数并保持相邻帧符号连续。`transform` 未声明或为空的 `translation`、`scale` 通道保持目标节点原值。

`groupTracks` 与所属 Clip 使用相同的 `duration`、`sampleRate`、`frames` 和阶梯采样规则。它跟随 Program 基础 Layer 当前引用的 Clip 播放，不参与 Humanoid Additive Layer 或手部 PoseSlot 的合成。

播放器只在动作文件与模型条目都声明了非空 `motionGroup`，并且两个值完全相同
时应用 `groupTracks`。缺失或不匹配时必须忽略全部 `groupTracks`，但仍正常播放
`tracks`、状态机、Additive Layer 和 PoseSlot。`motionGroup` 不参与 head/body 组合判定，
也不能替代标准 Humanoid 兼容性。

`node` 引用 GLB JSON 中原始、大小写敏感的 `node.name`。目标必须唯一；`morph`
轨道的 `property` 也必须在目标节点的 Morph Target 中唯一。零命中或多命中时跳过
该条专属轨道，不得任选或广播写入，也不得影响标准 Humanoid 轨道的播放。
停止或卸载动作时，须恢复专属轨道改写前的 Morph 权重、局部 TRS 或可见性。

### 1.4 存储编码

一个动作可选择以下任一种编码交付：

- 纯 JSON 编码：文件以 `.json` 结尾，保存本节定义的完整根对象。
- 单文件二进制编码：文件以 `.motionbin` 结尾，将元数据、结构和采样数组存入同一文件。

两种编码是同一份自包含动作数据的可选表示，任选一种即可。它们具有相同的字段含义、
轨道采样和播放规则。

`.motionbin` 的字节布局如下：

| 顺序 | 内容 |
|---|---|
| 1 | 8 字节文件签名：ASCII `MOTION` 后接两个零字节 |
| 2 | 4 字节无符号小端整数：紧随其后的 UTF-8 JSON 头字节数 |
| 3 | JSON 头：动作元数据、全部结构、Program 和非采样字段 |
| 4 | 零字节填充，使后续二进制区起点相对文件起点对齐到 8 字节 |
| 5 | 连续的采样数值数组，按各自描述符指定的位置读取 |

JSON 头的 `type`、`name`、`description`、`motionGroup` 以及 `clips`、
`auxiliaryClips`、`leftHandPoses`、`rightHandPoses` 和 `program` 与纯 JSON 编码相同；
可选字段仍按各自规则省略。仅轨道内非空的 `rotation`、`translation`、
`scale`、`values` 数组换成二进制区描述符，例如：

```json
"rotation": { "offset": 0, "length": 100, "type": "f32" }
```

`offset` 是相对二进制区起点的字节偏移，`length` 是数值个数。`type` 为 `f32` 或
`f64`，分别表示小端 IEEE 754 32 位或 64 位浮点数。偏移必须按数值宽度对齐，
所指字节范围必须完整位于文件内。使用 `f32` 时须与纯 JSON 数值精确相同，
不能为了缩小文件而量化；无法以 `f32` 精确表示的数组使用 `f64`。未声明及空数组
沿用纯 JSON 编码。解码后再按本节其余约束解释和播放动作。

---

## 2. 轨道数值语义

### 2.1 旋转

`rotation` 不是骨的绝对局部旋转。它是相对 Unity zero-muscle 中性姿势、表达在该骨
解剖关节坐标框架内的局部右乘增量。模型骨轴按[归一化标准](standardized_model_spec.md) §4 生成；动作轨道按以下
唯一当前语义计算和播放。

```text
D_b = Wsample_b * inverse(Wneutral_b)
B_b = Wneutral_b * Avatar.GetPostRotation(b)   // Hips 的 B_b 为模型轴单位旋转
delta_b = inverse(B_b) * inverse(D_p) * D_b * B_b
```

- `Wneutral_b` 和 `Wsample_b`：该骨在 Unity zero-muscle 姿势与真实 Unity Humanoid
  解算采样帧中的模型空间世界旋转，均已移除角色根的世界变换。
- `D_b`：该骨相对 zero-muscle 的模型空间世界旋转形变。
- `B_b`：按[归一化标准](standardized_model_spec.md) §4 从烘焙 Avatar 求出的解剖关节坐标框架。
- `p`：该骨在标准 GLB 层级中的实际规范父核心骨；`D_p` 按同一方式取得。`Hips`
  的父级是模型空间根框架，场景中的整体根变换已剔除，故 `D_p` 为单位四元数。来源骨架中夹入的辅助节点不改变
  此父级选择。
- 写入 `rotation` 的值：`delta_b` 经坐标转换后的结果；烘焙时仅把 Unity 已解算的
  骨旋转换算为标准局部关节轨道，不自行求解 muscle。

Unity 四元数转换到 glTF 坐标时使用：

```text
(x, y, z, w)Unity -> (x, -y, -z, w)glTF
```

四元数必须归一化。相邻两帧四元数点积小于零时，应将后一帧整体取反，使同一旋转沿连续的四元数半球保存。

播放器在目标模型上恢复局部旋转：

```text
QtargetLocal = QreferenceLocal * Qstored
```

`QreferenceLocal` 从目标 GLB 加载后的 zero-muscle 中性姿势取得。播放器必须先保存
参考姿势，再写入动作结果；不得按来源游戏或目标模型重新烘焙或修正 `Qstored`。

### 2.2 Hips 位移

只有 `Hips` 保存位移。烘焙器在参考模型空间计算相对中性姿势的位移，再除以参考 Avatar 的人体比例：

```text
Tnormalized = (THipsSampleModel - THipsNeutralModel) / referenceHumanScale
(x, y, z)Unity -> (-x, y, z)glTF
```

播放器使用目标模型的有效 `humanoidScale` 恢复位移幅度。该值来自权威 `body` 或
`integrated` 组件的静态 `humanoidScale`，也可由模型 Behavior 在初始化时更新：

```text
THipsTargetModel = THipsReferenceModel + Tnormalized * targetEffectiveHumanoidScale
```

随后根据 Hips 父节点相对模型根的变换，把模型空间位置转换为 Hips 局部位置。该位移描述身体重心和姿势变化，播放器不把它累计到场景中的模型根节点。

### 2.3 Additive 片段

`auxiliaryClips` 保存相对基础采样结果的增量。来源系统中的 Layer、权重求值和骨骼 Mask 必须在转换阶段处理；标准文件里的轨道已经是播放器可直接合成的关节局部增量。

权重为 `w` 的 Additive 旋转和位移按以下规则合成：

```text
Qweighted = slerp(identity, Qadditive, w)
Qresult = normalize(Qresult * Qweighted)
Tresult = Tresult + Tadditive * w
```

---

## 3. Program

`program` 用显式引用描述动作如何播放。下面的名称只作格式示例，播放器对名称文本没有内置解释。

```json
{
  "parameters": [
    { "id": "exitRequested", "type": "bool", "default": false }
  ],
  "commands": {
    "stop": [
      { "parameter": "exitRequested", "value": true }
    ]
  },
  "baseLayer": "Body",
  "layers": [
    {
      "id": "Body",
      "blend": "override",
      "weight": 1.0,
      "initialState": "enter",
      "states": [
        {
          "id": "enter",
          "clip": "stand_enter",
          "speed": 1.0,
          "loop": false,
          "transitions": [
            {
              "to": "idle",
              "exitTime": 1.0,
              "duration": 0.0,
              "offset": 0.0,
              "conditions": []
            }
          ]
        },
        {
          "id": "idle",
          "clip": "stand_idle",
          "speed": 1.0,
          "loop": true,
          "transitions": [
            {
              "to": "exit",
              "exitTime": null,
              "duration": 0.0,
              "offset": 0.0,
              "conditions": [
                { "parameter": "exitRequested", "operator": "isTrue" }
              ]
            }
          ]
        },
        {
          "id": "exit",
          "clip": "stand_exit",
          "speed": 1.0,
          "loop": false,
          "transitions": []
        }
      ]
    },
    {
      "id": "Secondary",
      "blend": "additive",
      "weight": 0.5,
      "initialState": "secondaryLoop",
      "states": [
        {
          "id": "secondaryLoop",
          "clip": "secondary_loop",
          "speed": 1.0,
          "loop": true,
          "transitions": []
        }
      ]
    }
  ],
  "poseSlots": [
    {
      "id": "leftHand",
      "default": "relaxed",
      "options": [
        { "id": "relaxed", "clip": "left_relaxed" },
        { "id": "closed", "clip": "left_closed" }
      ]
    }
  ]
}
```

### 3.1 顶层字段

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `parameters` | `Parameter[]` | 状态机参数，ID 必须唯一 |
| `commands` | object | 公开命令名到参数赋值数组的映射 |
| `baseLayer` | string | 引用一个 `layers[].id` |
| `layers` | `Layer[]` | 同时运行的动作层 |
| `poseSlots` | `PoseSlot[]` | 可独立选择的稀疏姿势覆盖槽 |

`baseLayer` 指向的 Layer 必须满足 `blend == "override"` 且 `weight == 1`。一个 Program 有且仅有这一层作为 Override 基础层，其余 Layer 均为 Additive。

### 3.2 Parameter 与 Command

```json
{ "id": "speed", "type": "float", "default": 0.0 }
```

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `id` | string | 参数 ID，在 `parameters` 内唯一 |
| `type` | string | `float`、`int`、`bool` 或 `trigger` |
| `default` | number 或 boolean | `float` 使用有限数值，`int` 使用整数，`bool` 使用布尔值，`trigger` 固定为 `false` |

以上四个 `type` 值是完整枚举，对应 Unity Animator 的四类参数。`trigger` 是一次性布尔信号：值为 `true` 且被一条实际触发的过渡条件使用后，播放器立即把它复位为 `false`。

`commands` 的键是应用可调用的公开命令，值是依次执行的参数赋值。每个赋值为 `{ "parameter": string, "value": number | boolean }`；`parameter` 必须引用已声明参数，`value` 必须符合其类型。给 `trigger` 赋 `true` 等同于 SetTrigger，赋 `false` 等同于 ResetTrigger。空赋值数组是合法命令。应用只需知道公开命令名，无需知道内部参数名。

### 3.3 Layer

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `id` | string | Layer ID，在 `layers` 内唯一 |
| `blend` | string | `override` 或 `additive`；两者是完整枚举 |
| `weight` | number | 固定权重，范围 `[0, 1]` |
| `initialState` | string | 引用本 Layer 的一个 `states[].id` |
| `states` | `State[]` | 本 Layer 的状态 |

每个 Layer 有独立的当前状态和播放时间。Layer 按数组顺序求值；基础层提供初始结果，Additive 层依次乘入旋转并累加 Hips 位移。

### 3.4 State

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `id` | string | 状态 ID，在所属 Layer 内唯一 |
| `clip` | string | 引用动作包内全局唯一的 `Clip.id` |
| `speed` | number | 播放速度倍率 |
| `loop` | boolean | 到达片段末尾后是否循环 |
| `transitions` | `Transition[]` | 按数组顺序检查的出边 |

非循环状态播放完且没有可触发过渡时，保持最后一帧。播放器不得根据片段名称推断 `loop`。

### 3.5 Transition 与 Condition

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `to` | string | 引用同一 Layer 内的目标状态 |
| `exitTime` | number 或 `null` | 归一化退出时间；`null` 表示不要求播放进度 |
| `duration` | number | 过渡混合时长，单位为秒，必须大于等于零；`0` 表示瞬时切换 |
| `offset` | number | 进入目标片段时的归一化时间偏移 |
| `conditions` | `Condition[]` | 必须全部成立；空数组恒成立 |

Condition 结构如下：

```json
{ "parameter": "speed", "operator": "greater", "value": 0.5 }
```

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `parameter` | string | 引用一个已声明参数 |
| `operator` | string | 条件运算符，见下表 |
| `value` | number，可选 | 数值条件的比较值；布尔和 Trigger 条件不得携带 |

`operator` 是封闭枚举：

| 参数类型 | 可用运算符 | 判定 |
|---|---|---|
| `bool` | `isTrue`, `isFalse` | 参数分别为 `true` 或 `false` |
| `trigger` | `isTrue`, `isFalse` | Trigger 当前分别为已设置或未设置 |
| `float` | `greater`, `less` | 参数严格大于或严格小于 `value` |
| `int` | `greater`, `less`, `equals`, `notEquals` | 参数与整数 `value` 比较 |

`float` 不支持 `equals` 或 `notEquals`。

播放器按 `transitions` 数组顺序选择第一条同时满足退出时间和全部条件的过渡。`exitTime: null` 与 `exitTime: 0` 不等价：前者没有时间条件，后者要求当前状态时间到达零。

`duration == 0` 时，超出退出阈值的时间传递到目标状态：

```text
overflow = max(0, stateTime - sourceDuration * exitTime)
targetTime = targetDuration * offset + overflow
```

`exitTime` 为 `null` 时，条件成立即切换，目标时间从 `targetDuration * offset` 开始。

`duration > 0` 时，播放器建立一个同时包含来源状态和目标状态的活动过渡：

- 来源状态从触发过渡时的播放位置继续按自身 `speed` 推进。
- 目标状态从 `targetDuration * offset` 开始，按自身 `speed` 推进。
- 过渡计时使用未乘状态速度的播放时钟；混合进度为 `u = clamp(transitionTime / duration, 0, 1)`。
- 每根骨的旋转为 `slerp(Qsource, Qtarget, u)`，Hips 位移为 `lerp(Tsource, Ttarget, u)`。
- 任一侧缺少某根可选骨轨道时，该侧对该骨使用单位旋转增量和零位移。
- `u` 到达 `1` 后结束过渡，目标状态及其当前播放位置成为 Layer 的正式状态。

这里的 `duration` 始终使用秒，不保留来源引擎的计时模式。Unity 转换器遇到 Fixed Duration 时直接读取秒数；遇到 normalized duration 时，按本格式 State 的固定速度换算：

```text
sourceCycleSeconds = sourceClip.duration / abs(sourceState.speed)
duration = unityNormalizedDuration * sourceCycleSeconds
```

`sourceState.speed == 0` 且过渡时长不是 Fixed Duration 时无法完成有限换算，转换器必须拒绝输出。Unity 对两种时长模式的区别见其 [Animation transitions 文档](https://docs.unity3d.com/cn/current/Manual/class-Transition.html)。

### 3.6 PoseSlot

| 字段 | 类型 | 约束与含义 |
|---|---|---|
| `id` | string | 姿势槽 ID，在 `poseSlots` 内唯一 |
| `default` | string | 默认选项，引用本槽的 `options[].id` |
| `options` | `PoseOption[]` | 可选择的姿势 |
| `options[].id` | string | 选项 ID，在本槽内唯一 |
| `options[].clip` | string | 引用动作包内一个姿势 `Clip.id` |

姿势槽独立计时并循环采样。选中的姿势轨道在所有 Layer 合成后，对同名骨进行完全覆盖。PoseSlot 引用的 Clip 只能包含对应手的标准手指骨旋转，不能包含手腕、手臂、身体骨或任何位移轨道。不同姿势槽的轨道不得包含同一根骨，以免覆盖顺序产生歧义。播放器可接受 `null` 作为运行时选择值，用于暂时关闭某个姿势槽；这不改变文件里的 `default`。

---

## 4. 通用播放器行为

| 输入 | 来源 | 用途 |
|---|---|---|
| `modelRoot` | 标准化模型 GLB | 查找标准骨并计算模型空间变换 |
| `effectiveHumanoidScale` | 模型 `config.json` 静态值或参数求值结果 | 恢复 Hips 位移幅度 |
| `modelMotionGroup` | 模型 `config.json` 的 `motionGroup` | 判定模型族专属轨道是否适用 |
| `motion` | 已解码的标准动作 | 片段、状态机、Layer 和姿势槽 |
| `deltaTime` | 播放时钟 | 推进各 Layer 和姿势槽 |

开始播放时，播放器须验证文件内 ID 与引用，使用 Behavior 初始化后的模型中性状态
和有效 `humanoidScale` 作为参考，以 Program 的默认参数、初始状态和姿势槽选项
建立播放状态。`groupTracks` 只在 `motionGroup` 匹配时参与播放。

每帧应：

1. 用 `deltaTime * state.speed` 推进每个 Layer。
2. 按过渡数组顺序触发满足条件的过渡，并推进已经开始的交叉混合。
3. 对基础 Layer 进行阶梯采样。
4. 按 Layer 顺序叠加 Additive 旋转和位移。
5. 对已选姿势槽采样，并覆盖其手指骨。
6. 按第 2 节公式把关节局部增量右乘到目标骨参考局部旋转。
7. 对基础 Layer 当前 Clip 的 `groupTracks` 进行同帧采样并写入匹配目标。
8. 更新模型层级矩阵。

释放播放器或卸载动作时，必须恢复开始播放前保存的骨骼局部位置和局部旋转，以及专属轨道改写的 Morph 权重、节点局部 TRS 和可见性。应用调用命令时只传 `commands` 的键；设置姿势时只传姿势槽和选项 ID。未声明的命令或选项不得由播放器猜测。

---

## 5. 转换器与播放器注意事项

- 烘焙每个普通片段前必须恢复 zero-muscle 中性姿势。使用上一个片段的末帧作基准会把残留姿势写进后续片段。
- Additive 动作不能作为普通片段单独采样。转换器应在相同基础状态下分别求值来源 Layer 开启和关闭时的结果，再导出纯增量；来源 AvatarMask 的效果也应在此时落实。
- 不能将来源骨骼 Transform 曲线直接当作已解算的 Humanoid 轨道；Avatar 映射、绑定姿势和骨轴差异须在转换阶段处理。
- 循环状态先按 `duration` 取模，再按 §1.1 钳制帧索引；非循环状态先钳制到 `duration`。末帧虽保存在数组中，循环播放时未必会实际采到。
- Unity 的 normalized transition duration 不能原值写入本格式，须按 §3.5 换算为秒；`exitTime: null` 也不能写成 `0`。
- 转换器须校验文件内部的 ID 唯一性和引用目标。`groupTracks` 的节点与 Morph Target 在实际目标模型上解析。

---

## 6. 格式边界

本规范负责 Humanoid 骨骼动作、Hips 相对位移、动作状态机、Additive 层、手部姿势槽，以及由 `motionGroup` 显式限定的 Morph Target、节点局部 TRS 和可见性专属轨道。模型静态表情、材质、Shader、相机、灯光及场景中的模型根移动由各自的数据和系统负责，不写入标准动作正文。
