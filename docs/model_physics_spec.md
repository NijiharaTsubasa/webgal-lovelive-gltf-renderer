# 模型物理字段标准

模型组件可通过 `physics` 描述辅助骨骼、布面的二次运动和碰撞。本文只定义数据及其含义，不指定求解库、积分算法或原游戏实现；不保证不同求解器的逐帧结果一致。单位、骨架和绑定姿态遵循[模型归一化标准](standardized_model_spec.md)。

## 1. 字段

`physics` 包含 `colliders` 和 `springs` 两个数组，以及可选的 `collisionEdges` 和 `cloths` 数组；没有摆动骨时 `springs` 为空。所有节点引用都是**当前模型组件 GLB 的节点索引**，不得用游戏骨名推断绑定。省略 `physics` 表示不声明此能力。

### 碰撞体 `colliders[]`

| 字段 | 类型 | 含义 |
|---|---|---|
| `shape` | string | `sphere`、`capsule`、`plane` 或 `panel` |
| `node` | integer | 非负节点索引，起点的绑定节点 |
| `offset` | number[3] | 起点在 `node` 局部空间中的位置 |
| `radius` | number | 球或胶囊的非负半径，以 `node` 局部长度计 |
| `tail` | object | 胶囊必需，含 `node` 与 `offset`，含义同起点；允许绑定另一个节点 |
| `normal` | number[3] | 平面必需，`node` 局部空间中的单位法向；法向侧为允许区域 |
| `halfAxes` | number[2][3] | 有限碰撞板必需，`node` 局部空间中两条非零、不平行的半边向量；长度直接表示半边长 |

球体中心为起点；胶囊为两端点间的等半径扫掠球，而非端点之间的总外轮廓长度。平面经过起点。碰撞体随绑定节点的变换更新；非均匀缩放时，球和胶囊半径按起点节点的最大世界伸缩量形成保守包络，平面法向按逆转置变换。

`panel` 是有限、单面的碰撞面，不是无限平面或有厚度的盒子。记两条半边向量为 `a`、`b`，四角为 `offset ± a ± b`，正面由 `a × b` 指定。板内接触阻止穿向背面；边和角只在实际接触范围内参与碰撞，不能把边界外的整个背面半空间当作障碍。两条向量随节点的线性变换更新，保留长度及非均匀缩放造成的形变。矩形是常见情况，也允许变换后的平行四边形；不额外保存可由两条向量推导的法向、宽高或旋转。

### 摆动骨 `springs[]`

| 字段 | 类型 | 含义 |
|---|---|---|
| `node` | integer | 要施加旋转的辅助节点；不得是标准 Humanoid 核心骨，同一节点只声明一次 |
| `tail` | number[3] | 此节点局部空间中的非零末端位置，定义受约束方向和长度 |
| `radius` | number | 末端碰撞球的非负局部半径，缩放规则同碰撞体 |
| `stiffness` | number | 非负回正强度；越大越倾向跟随当帧动画姿态，零表示没有回正作用 |
| `damping` | number | 0–1 的阻尼强度；零不耗散惯性，一表示完全耗散惯性 |
| `gravity` | number[3] | 世界坐标中的外力方向与强度向量，零向量表示无外力 |
| `colliders` | integer[] | 当前 `physics.colliders` 的索引，仅与列出的碰撞体交互 |

以上字段均必需，数值必须有限。回正、阻尼、外力是通用调节量，不是某原游戏同名参数的无损复制；其数值不承诺跨求解器物理等价。来源转换需要针对目标用途验证映射效果。

### 末端碰撞边 `collisionEdges[]`

| 字段 | 类型 | 含义 |
|---|---|---|
| `springs` | integer[2] | 当前 `physics.springs` 中两个不同条目的索引 |
| `colliders` | integer[] | 当前 `physics.colliders` 的索引，仅与列出的碰撞体交互 |

每项字段均必需，引用必须有效。碰撞边是两个摆动骨当帧世界末端之间的线段；接触半径在两端各自的世界末端半径之间线性变化。线段中间也参与碰撞，而不只检测两个端点。接触修正只改变这些辅助骨的旋转，保持骨段长度；这不是两末端之间的距离约束，不要求连边保持固定长度。省略数组或使用空数组表示没有末端碰撞边。

### 布面 `cloths[]`

每项选择一个现有 GLB 蒙皮网格的三角形 primitive，不重复保存顶点、三角形或蒙皮数据。

| 字段 | 类型 | 含义 |
|---|---|---|
| `node` | integer | 网格所在的 GLB 节点索引 |
| `primitive` | integer | 该节点所引用 mesh 内的三角形 primitive 索引 |
| `fixed` | integer[] | 固定顶点在该 primitive 的 `POSITION` 访问器中的索引；这些点始终跟随当帧动画后的网格位置 |
| `radius` | number | 非负碰撞间隙半径，以网格节点局部长度计；世界缩放规则同球体半径 |
| `stiffness` | number | 非负回正强度；越大越倾向跟随当帧未施加布料变形的网格，零表示没有回正作用 |
| `damping` | number | 0–1 的阻尼强度，含义同摆动骨 |
| `gravity` | number[3] | 世界坐标中的外力方向与强度向量 |
| `colliders` | integer[] | 当前 `physics.colliders` 的索引，仅与列出的碰撞体交互 |

每项字段均必需，数值有限。同一节点的同一 primitive 只声明一次；至少有一个固定点，索引不得重复或越界。固定点必须被该 primitive 的三角形使用。未固定的布面顶点参与求解，三角形定义布面的连接关系；纹理或法线接缝的顶点副本不应因此变成裂口。渲染网格仍保留原有 UV、材质和蒙皮绑定，不得将一次仿真结果永久改写为参考网格。

`radius` 是布面的碰撞间隙，不等于来源资产代理粒子的半径。回正、阻尼及外力同样是通用调节量；伸展、弯曲约束的具体构造和迭代次数由求解器决定，不属于本格式。

### 来源原版物理 `source`（可选）

上面的字段是与求解器无关的通用描述。`source` 保存来源游戏**原样的**物理组件数据，并配套原算法求解器。凡是 `source` 驱动的节点，不得再出现在 `springs` 中。

#### `source.unitySpringBone`：UnityChan SpringBone

用于莲之空等使用 UnityChan SpringBone（Unity.Animations.SpringBones）的模型。求解器是 `src/unity-springbone.js`：逐函数对照游戏代码移植，与参考实现逐帧一致。

| 字段 | 类型 | 含义 |
|---|---|---|
| `transforms` | object[] | 求解涉及的 Unity Transform 及其所有祖先 |
| `components` | object[] | `SpringManager`、`SpringBone`、`SpringBonePivot`、`SpringSphereCollider`、`SpringCapsuleCollider`、`SpringPanelCollider` 组件 |

每个 `transforms[]` 项：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | Transform 在来源资产里的 path id（十进制字符串；64 位整数不能存成 JSON number） |
| `name` | string | Transform 名，仅供调试 |
| `parentId` | string \| null | 父 Transform 的 `id` |
| `localPosition` / `localRotation` / `localScale` | number[3] / number[4] / number[3] | Unity 局部变换（左手系，四元数 x,y,z,w），**必须与 GLB 的静止姿态是同一个姿态** |
| `node` | integer \| null | 对应的当前组件 GLB 节点索引；`null` 表示 GLB 里没有这个节点（例如被省略的 pivot、碰撞体挂点），求解器按 Unity 静止变换补出 |

每个 `components[]` 项：

| 字段 | 类型 | 含义 |
|---|---|---|
| `class` | string | 组件类名 |
| `transformId` | string | 所在 Transform 的 `id` |
| `fields` | object | 组件序列化字段原样保留（`stiffnessForce`、`dragForce`、`springForce`、`angularStiffness`、`yAngleLimits`、`zAngleLimits`、`radius`、碰撞体引用等）；对其他组件的引用写成 `{ "transformId": id }` |

运行时按静止姿态拟合 Unity 与 GLB 的关系：X 镜像、旋转、等比缩放、平移，每个节点再加一个常量静止朝向偏移，所以归一化过的骨架也能使用。

运行语义与游戏一致：
- 每个 60 fps 固定步执行一次所有 SpringManager 的 LateUpdate；积分步长固定为 `1 / simulationFrameRate`，不随帧间隔变化；
- 嵌套的两个 SpringManager 会把同一根骨各模拟一次；
- `m_Enabled = 0` 的 SpringBone 不被模拟，继续跟随动画。

重置（载入、切换动作、瞬移、重新启用）时，所有骨回到初始局部旋转、速度清零，再按 `reset` 的预热步数稳定。

#### `source.magicaCloth2`：MagicaCloth2

用于使用 MagicaCloth2 的模型（莲之空）。结构与 `unitySpringBone` 相同，也是 `transforms` 加 `components`。

**`transforms`**：同上。BoneCloth 根骨以下的整条骨链都会列出。

**`components`**：`MagicaCloth`、`MagicaCapsuleCollider`、`MagicaSphereCollider`、`MagicaPlaneCollider`，以及来源游戏加的 `ExtendClothSettings`。字段原样保留，只有以下几类改写。

引用改写成对象：

| 被引用的对象 | 写法 |
|---|---|
| Transform、GameObject | `{ "transformId" }` |
| 组件 | `{ "transformId", "class" }` |
| 蒙皮渲染器 | `{ "transformId", "class", "mesh": { "name", "node", "primitives" } }`，`node` 是 GLB 中对应的渲染节点索引 |
| Mesh | `{ "mesh": { … } }` |
| 资产（ScriptableObject） | `{ "asset", "class" }` |
| 贴图 | `{ "texture" }` |

原始字节数组写成 `{ "base64" }`：包括 `ExSimpleNativeArray` 的 `arrayBytes`，以及 VirtualMesh、RenderSetupData 的 `byte[]` 字段。内容是 MagicaCloth2 序列化时的小端结构体原样。

浮点数是 float32 值的最短十进制写法，用 `Math.fround` 即可还原出精确的 float32。

PreBuild 数据嵌在 `serializeData2.preBuildData` 里：
- `enabled`、`buildId`、`uniquePreBuildData` 照原样保留；
- `preBuildScriptableObject` 写成 `{ "asset", "class" }`；
- 该资产里 `buildId` 相同的那一项 SharePreBuildData 嵌入为 `sharePreBuildData`，包括代理网格、渲染映射、距离 / 弯曲 / 惯性约束数据；
- `sharePreBuildData.renderSetupDataList` 省略了原始网格的整份拷贝（顶点、法线、切线、绑定矩阵、蒙皮权重），因为 GLB 里有这个网格，渲染顶点到代理点的映射和网格空间顶点在 `renderMeshList` 里。

求解器正在移植。在求解器完成之前，转换器同时输出通用的 `springs` / `cloths` 作为后备，渲染器使用后备数据，`source.magicaCloth2` 只做校验。

## 2. 运行语义

物理在动作及 Behavior `LateUpdate` 之后、`PostPhysics` 与绘制之前更新。动作/Behavior 的当帧结果是参考姿态；运行时不得把上一帧物理修改误当成新的动画输入。摆动骨只修改声明节点的旋转，保持骨段长度；布面在骨骼更新后求解网格位置。不改 Humanoid 动作、参考骨架或逆绑定矩阵。物理后的 Behavior 若修正了辅助骨姿态，求解状态应同步到修正结果，且仍保留动画参考姿态。

蒙皮网格的固定位置和回正目标按当帧骨骼及形态权重求得。布面求解后的世界位置必须正确适配回渲染空间，不能再次蒙皮造成双重变换；法线和所有引用同一网格的渲染 Pass 应同步看到变形。不存在的节点、primitive 或固定顶点必须报错。

模型合成后，head 的核心骨碰撞引用必须重绑到 body 的权威核心骨；独有辅助节点仍指向原部件对象。解析不存在的节点、重复控制同一节点或无效碰撞索引必须报错。

暂停、切换动作、重新载入或关闭物理时，不能把求解状态烘入动作或永久改变参考姿态。初次显示可以先使物理稳定，避免初始重叠闪现；具体时间步、迭代次数和稳定方法不属于资源字段。

## 3. 能力边界

本格式表达辅助骨末端、末端连边与显式碰撞体的碰撞，以及三角布面、固定点与显式碰撞体的交互；不表达布面自碰撞、多层衣物互撞或来源引擎的完整物理解算。几何采样密度、碰撞体覆盖和求解器能力仍会影响结果，声明物理不等于保证任意姿势零穿模。
