# 模型表情标准

本文定义模型自带表情的存储方式，以及渲染器如何根据表情选择和眼口开合值计算脸部形变。组件根字段见[模型资源格式标准](model_package_spec.md)，Morph Target 结构见[模型归一化标准](standardized_model_spec.md)。

模型可以提供独立眼口组合或完整脸部表情。独立组合分别选择眼型、闭口姿态和张口姿态，例如“悲伤的眼睛、微笑的闭嘴姿态、A 发音的张嘴姿态”；完整脸部表情只选择一个状态，例如“悲伤”。两种方式都可以在所选表情上控制眨眼和嘴巴开合。

这些选择最终通过模型提供的 Morph 配方作用于 GLB 的 Morph Target。Morph Target 是 GLB 中保存的网格形变；配方是一组命名的形变权重，可以同时改变多个 Morph Target。应用按模型提供的状态名称进行选择，渲染器负责解析配方并写入实际权重。

## 1. 模型字段

以下字段属于 `head` 或 `integrated` 模型组件。

| 字段 | 类型 | 含义 |
|---|---|---|
| `morphPoses` | `MorphPose[]` | 必需，可为空；保存命名配方，每个配方指定一组实际 Morph Target 权重 |
| `expressionGroups` | `ExpressionGroup[]` | 必需，可为空；列出可选的独立眼口状态或完整脸部状态，并引用上述配方 |
| `defaultExpression` | `ExpressionSelection` | 可选；指定初始表情选择 |

## 2. Morph 配方

### 2.1 配方字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | 模型组件内唯一的非空配方名，供状态引用 |
| `targets` | object | 节点名 → Morph Target 名 → 权重 |

下面的配方名为 `mouth.smile`，它把 GLB 中 `Face` 节点上的 `mouthSmile` Morph Target 设为权重 1。一个配方也可以列出多个节点和多个 Morph Target。

```json
{ "name": "mouth.smile", "targets": { "Face": { "mouthSmile": 1 } } }
```

### 2.2 配方如何作用于模型

状态引用配方时还会给出一个系数。配方中每个目标的权重乘以该系数，得到它对模型的贡献；多个配方影响同一个目标时，贡献相加。例如，配方内的 `mouthSmile` 权重为 0.8，使用配方的系数为 0.5，最终贡献就是 0.4。

用公式表示，`q[p]` 是配方 `p` 的使用系数，`targets[p,m]` 是该配方为目标 `m` 保存的权重，`W[m]` 是最终写入目标的权重：

```text
W[m] = Σ q[p] × targets[p,m]
```

省略的目标贡献为零。配方权重和使用系数必须是有限实数，可以为负或大于 1；求值结果不自动限制范围，也不自动把各系数的总和缩放到 1。

目标节点使用 GLB 中原始、大小写敏感的 `node.name`，Morph Target 名使用 `mesh.extras.targetNames`。引用的节点必须唯一，Morph Target 名在该节点的 mesh 中必须唯一。一个 mesh 拆成多个 primitive，或同一节点有多个运行时绘制实例时，它们须呈现相同的目标权重。无效引用或非有限结果报错。

## 3. 表情分组

`expressionGroups` 有两种组织方式：独立眼口组合使用 `type: "eye"` 和 `type: "mouth"`，每种最多一个组，也可以缺少其中一种；完整脸部表情使用一个 `type: "face"` 组，不能同时提供 `eye` 或 `mouth` 组。组的 `name` 可以自定，渲染器通过 `type` 识别用途。

| 字段 | 含义 |
|---|---|
| `name` | 组件内唯一的非空分组名 |
| `type` | `eye`、`mouth` 或 `face`；决定选择和开合语义 |
| `states` | 非空数组，列出该组的所有可选状态 |
| `states[].name` | 分组内唯一的非空状态名，供调用者选择 |
| `states[].poses` | 配方名 → 使用系数；省略的配方系数为零 |
| `states[].controls` | 可选，提供眨眼、开口或发音口型的目标姿态，见下文 |
| `states[].mouth` | 仅用于眼型，可选；`{ "closed": 状态名, "open": 状态名 }` 指定该眼型配套的两个口型 |

例如，一个口型状态可以写成：

```json
{ "name": "Smile", "poses": { "mouth.smile": 1 } }
```

调用者选择 `Smile`，渲染器使用 `mouth.smile` 配方，系数为 1。状态名和配方名是不同层次的引用，不要求相同。

眼型可同时包含眼睛、眉毛等随眼部表情变化的形变；口型保存一个实际口部姿态。口型列表中的状态可分别用于闭口和张口，具体组合由调用者选择。

眼型的 `mouth` 引用同一组件口型组中的状态。例如 `{ "name": "Sad", "poses": { "eye.sad": 1 }, "mouth": { "closed": "Sad/close", "open": "Sad/a" } }`。多个眼型可以引用同一套口型；配套引用只用于补齐选择，不限制调用者重新组合眼口。

### 3.1 眼型的眨眼目标

眼型状态的 `poses` 保存睁眼时或该眼型自身的基础姿态，`controls.blink` 保存眨眼完成时的目标配方系数。例如：

```json
{
  "name": "Open",
  "poses": { "eye.open": 1 },
  "controls": { "blink": { "eye.open": 0, "eye.close": 1 } }
}
```

眨眼开始时使用 `eye.open`，完成时撤去它并使用 `eye.close`。`blink` 中省略的配方保持基础系数不变；要撤去基础配方，必须显式写 0。这使眨眼可以只改变眼皮，而保留眉毛等形变。

固定闭眼的状态可省略 `blink`，此时开合输入不会改变该眼型。Wink 状态的眨眼目标只关闭原本睁着的一侧，已经闭着的一侧保持闭合。

### 3.2 口型的发音映射（可选）

口型状态可在 `controls.visemes` 中提供“发音名 → 配方系数表”，例如：

```json
{ "visemes": { "a": { "mouth.a": 1 }, "i": { "mouth.i": 1 } } }
```

每个发音表描述完整的口部目标姿态，省略的配方系数为零。`a/i/u/e/o` 为共同发音标识。发音输入的混合方式见 §5.3。

### 3.3 完整脸部表情

`face` 状态的 `poses` 保存基础脸部姿态；提供 `speech` 时，其中嘴巴为闭口。`controls.blink` 和 `controls.speech` 分别保存闭眼和张口完成时的目标配方系数；两者都是稀疏表，省略的配方保持基础系数，显式 0 撤去基础配方。固定眼部或口部姿态可省略相应控制，此时保持基础形变。

例如，源形变 `happy` 已经张嘴，另一个配方 `mouth.closeHappy` 将它闭合，则可以保存：

```json
{
  "name": "Happy",
  "poses": { "face.happy": 1, "mouth.closeHappy": 1 },
  "controls": {
    "blink": { "eye.close": 1 },
    "speech": { "mouth.closeHappy": 0 }
  }
}
```

闭口时保留闭嘴修正；张口时撤去修正，而不是再叠加另一个口型。可选 `controls.visemes` 也使用稀疏目标语义：每个发音只修改列出的配方，其余保留基础系数。

## 4. 组合选择和默认值

`ExpressionSelection` 是一次完整的表情选择，包含以下字段：

| 字段 | 含义 |
|---|---|
| `eye` | 眼型组中的状态名，控制眼睛及随眼型变化的眉毛等 |
| `closed` | 口型组中的状态名，嘴巴开合值为 0 时使用 |
| `open` | 口型组中的状态名，嘴巴开合值为 1 时使用 |
| `face` | 完整脸部组中的状态名；不能与上述三个字段同时使用 |

例如：

```json
{ "eye": "Sad", "closed": "Smile", "open": "A" }
```

上述组合使用 `Sad` 眼型，嘴巴在 `Smile` 和 `A` 两种姿态之间变化。眼型与两种口型独立选择；`closed`、`open` 指定开合输入的两个端点，而不是口型状态本身的分类字段。

完整脸部方式使用 `{ "face": "Sad" }`。独立方式存在眼型组时提供 `eye`，缺少某种组时省略其对应字段。省略 `closed` 或 `open` 时，取所选眼型的 `mouth` 配套引用；没有配套引用则取口型组首项。显式指定的口型优先。所有状态引用必须存在。`closed` 和 `open` 可以选择相同状态，此时嘴巴保持该姿态。

模型的 `defaultExpression` 使用同一结构。未声明时，完整脸部方式取 `face` 组首项；独立方式取眼型组首项，并按上述规则补齐口部。资源提供的默认 `closed` 应为真实闭嘴姿态；调用者仍可选择其他口型作为自己的两个端点。

## 5. 开合求值

### 5.1 眼睛开合

眨眼输入 `blink` 在 `[0,1]` 内：0 使用所选眼型的基础姿态，1 使用它的闭眼目标，0.5 为两者配方系数各占一半。若应用提供的是“眼睛开合度”（0 闭眼、1 睁眼），则转换为 `blink = 1 − 眼睛开合度`。

基础姿态与闭眼目标按配方系数线性混合。固定闭眼状态及 Wink 已闭合的一侧保持不变，见 §3.1。

### 5.2 嘴巴开合

嘴巴开合输入 `speech` 在 `[0,1]` 内：0 使用所选 `closed` 状态，1 使用所选 `open` 状态，0.5 为两种姿态各占一半。例如组合选了 `closed: "Smile"`、`open: "A"`，值为 0.25 时就是 75% 的 Smile 姿态加 25% 的 A 姿态。

两种口型均按完整的配方系数表参与混合，省略的配方为零。公式中 `closed[p]`、`open[p]` 分别表示两种状态为配方 `p` 指定的系数：

```text
mouth[p] = (1 − speech) × closed[p] + speech × open[p]
```

眼型求出的配方系数与口型求出的配方系数相加，再按 §2.2 写入实际 Morph Target。数据须保证眼部与口部能独立控制：改变眨眼进度不得改变口部形变，改变嘴巴开合不得改变眨眼形变。

### 5.3 发音口型输入（可选）

应用可提供 `visemes` 输入，例如 `{ "a": 0.4, "i": 0.2 }`。此时渲染器使用当前 `open` 状态的 `controls.visemes`，混合 40% 的 a 目标、20% 的 i 目标，以及剩余 40% 的 `closed` 姿态。

每个系数在 `[0,1]` 内，总和不大于 1。公式中的 `target[k,p]` 是发音 `k` 为配方 `p` 提供的系数：

```text
mouth[p] = (1 − Σ visemes[k]) × closed[p] + Σ visemes[k] × target[k,p]
```

`visemes` 生效时替代 `speech`，不再叠加嘴巴开合输入；空对象表示只使用闭口姿态。退出发音输入后，恢复按 `speech` 求值。

独立眼口方式的有效发音名为模型所有口型状态的发音映射键的并集；完整脸部方式为所有脸部状态的发音映射键的并集。模型中存在、但当前 `open` 状态没有映射的发音，其份额使用闭口姿态。未知名称、越界系数或超过 1 的总和报错。

### 5.4 完整脸部开合

完整脸部方式以基础配方系数为起点，分别叠加闭眼、张口目标与基础的差值：

```text
q[p] = base[p] + blink × (blinkTarget[p] − base[p])
              + speech × (speechTarget[p] − base[p])
```

目标表中省略的配方取基础系数，因此对应差值为零。眨眼和说话只改变各自需要修改的形变；数据须保证二者可独立控制。使用发音输入时，张口差值改为 `Σ visemes[k] × (target[k,p] − base[p])`，替代 `speech` 项；系数范围与总和要求同 §5.3。当前状态没有对应发音目标时，该份额保持基础姿态。

## 6. 切换和生命周期

切换组合时可提供以秒计的非负有限过渡时间，0 表示立即切换。过渡在配方系数层混合“切换前已经显示的结果”和“新组合按当前开合输入求出的结果”。过渡中再次切换时，从当时已显示的结果继续过渡。切换组合保留 `blink`、`speech` 和 `visemes` 输入，因此换眼型或口型不会重启眨眼和说话进度。

表情系统管理的 Morph Target 是所有配方引用目标的并集。每帧重新计算这些目标的权重：当前结果没有贡献的目标归零，避免残留上一种表情。没有被任何配方引用的目标不受表情系统控制。重置时恢复默认组合，将 `blink`、`speech` 清零，并退出发音及低层配方输入。

启用模型自带表情时，它的结果覆盖动作对上述目标的写入；停用或卸载时撤去表情写入，由动作或其他合法写入者接管。节点的局部位移、旋转、缩放及显隐由相应 Behavior 处理。

渲染器可提供低层配方输入，直接指定“配方名 → 系数”。这种输入按 §2.2 求值，不同时叠加组合和开合控制；恢复组合控制后重新使用开合输入。Behavior 可通过只读查询取得表情定义、当前组合及过渡后的配方系数 `poseWeights`，见[模型 Behavior 标准](model_behavior_spec.md)。

## 7. 完整示例

以下为模型组件中的表情字段。`Face` 节点及各 Morph Target 名仅用于示例。

```json
{
  "morphPoses": [
    { "name": "eye.open", "targets": { "Face": { "eyeOpen": 1 } } },
    { "name": "eye.close", "targets": { "Face": { "eyeClose": 1 } } },
    { "name": "mouth.smile", "targets": { "Face": { "mouthSmile": 1 } } },
    { "name": "mouth.a", "targets": { "Face": { "mouthA": 1 } } }
  ],
  "expressionGroups": [
    { "name": "eye", "type": "eye", "states": [
      { "name": "Open", "poses": { "eye.open": 1 },
        "controls": { "blink": { "eye.open": 0, "eye.close": 1 } } },
      { "name": "Close", "poses": { "eye.close": 1 } }
    ] },
    { "name": "mouth", "type": "mouth", "states": [
      { "name": "Smile", "poses": { "mouth.smile": 1 } },
      { "name": "A", "poses": { "mouth.a": 1 } }
    ] }
  ],
  "defaultExpression": { "eye": "Open", "closed": "Smile", "open": "A" }
}
```

这个模型初始选择 `Open` 眼型，嘴巴在 `Smile` 与 `A` 之间变化：

| 输入 | 实际 Morph Target 权重 |
|---|---|
| `blink = 0`、`speech = 0` | `eyeOpen = 1`，`mouthSmile = 1`，其余为 0 |
| `blink = 0.5`、`speech = 0.25` | `eyeOpen = 0.5`，`eyeClose = 0.5`，`mouthSmile = 0.75`，`mouthA = 0.25` |
| `blink = 1`、`speech = 1` | `eyeClose = 1`，`mouthA = 1`，其余为 0 |

若把 `eye` 改为 `Close`，眼睛始终使用 `eyeClose = 1`，嘴巴仍可独立开合。
