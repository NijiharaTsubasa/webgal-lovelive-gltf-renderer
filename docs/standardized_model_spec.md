# Humanoid 模型归一化标准

Unity 的 Mecanim 动画系统通过 Humanoid Avatar 屏蔽不同模型的底层骨架差异：只要
Avatar 配置正确，同一份 Humanoid 动作就能在结构不同的模型上播放。本项目将这类
模型和动作移植到 Web，仍需保持动作的跨模型通用性，但 Web 播放器不能依赖 Unity
运行时的 Humanoid 解算。

因此，转换阶段须借助 Unity 真实解算 Avatar 与动作，再把来源模型的骨架层级、有效
蒙皮中性姿势和关节轴归一化为统一的 glTF 契约，在产物中消除阻碍通用动作播放的
实现差异。骨长和体型差异仍然保留。本文规定归一化后的骨架与蒙皮结果，以及它与
通用动作的接口；不限定转换器除 Unity 解算外的内部实现。

模型组件字段、头身组合与 Behavior 声明见[模型资源格式标准](model_package_spec.md)；表情配方和控制接口见[表情标准](model_expression_spec.md)。

## 1. 坐标系和根节点

- glTF 使用右手坐标系：+Y 向上、+Z 向前、+X 向右；
- 长度单位为米；
- 角色根节点的参考旋转为单位旋转、缩放为 `[1,1,1]`；不得残留导入补偿旋转；
- `Hips` 的参考模型空间旋转为单位旋转，即 §4 所称的模型轴；
- `Hips` 高度可以随模型比例变化，但参考位置、角色原点和地面关系必须遵守标准；
- 镜像和左右手系转换必须同时作用于节点、网格、法线、切线、蒙皮矩阵和动画。

## 2. 核心骨名称和层级

核心骨名称严格使用 `UnityEngine.HumanBodyBones` 的有效枚举名称，不包含
`LastBone` 哨兵。具体模型可以
缺少 Unity 允许缺失的可选骨。

核心骨必须形成标准规定的逻辑层级。若来源骨架在两个核心骨之间插入扭转骨、挂点
或其他辅助节点，转换后不得让该节点继续改变核心骨动画的局部参考空间。实现可以
重设父子关系、增加标准中间节点，或迁移辅助骨，但同一条核心骨轨道不能因为来源
层级不同而需要不同算法。

非核心骨可以保留来源名称，但不得与核心骨重名。

当前核心骨直接层级按以下语义链确定：

- `Hips -> Spine -> Chest -> UpperChest -> Neck -> Head`；
- 左右腿分别为 `Hips -> UpperLeg -> LowerLeg -> Foot -> Toes`；
- 左右手臂分别为 `UpperChest -> Shoulder -> UpperArm -> LowerArm -> Hand`；
- 每根手指均为 `Hand -> Proximal -> Intermediate -> Distal`；
- `LeftEye`、`RightEye` 和 `Jaw` 的直接父骨为 `Head`。

模型缺少可选骨时，后代核心骨连接到沿上述语义链向上最近的现存核心骨。例如缺少
`UpperChest` 时，`Neck` 和肩部连接到 `Chest`。`Hips` 连接到角色根节点。

## 3. Unity Humanoid 解算与标准中性姿势

模型必须具有标准定义的有效蒙皮中性姿势。该姿势描述最终渲染出的身体和网格状态，
不只是骨节点 JSON 中写入了一组看似标准的 TRS。

**Humanoid 姿态和动画必须使用 Unity Humanoid 系统解算，不许手算。**转换器不得
自行逆向、拟合或数学近似 Humanoid muscle 与骨骼旋转之间的关系，也不得把来源
AnimationClip 的局部骨骼轨道直接当作标准动作。

输入资源没有内嵌 Avatar 时，转换器可以根据已经验证的 HumanDescription 和骨骼映射，
通过 Unity 官方 API 构建或取得有效 Avatar；后续姿态和动画仍必须交给 Unity Humanoid
系统解算。这不构成手算例外。

当前标准中性姿态的动作语义是 Unity Humanoid 的 zero-muscle pose。转换器必须通过
上述官方解算得到该姿态，再把解算出的骨旋转与有效蒙皮表达于本文规定的
核心骨层级和解剖关节坐标框架。不得直接把 Avatar 的 zero-muscle 局部 TRS 原样作为输出。

zero-muscle 解算只决定参考骨旋转。骨长、关节锚点和模型比例由来源模型原有的局部
平移表达，解算器写回的 Avatar authoring-pose 局部平移或缩放不得烘焙到输出。特别是
眼睛、手指和末端骨不能因为 Avatar 描述与实际蒙皮骨位置不同而发生关节中心漂移。

标准中性姿势同时是标准动作的语义参考点。动作旋转表示从该姿势到目标帧的变化，
不能相对来源模型的 FBX bind pose、Prefab 初始姿势或游戏待机姿势计算。

## 4. 核心骨轴向

每个核心骨在 zero-muscle 中性姿势中的规范世界旋转框架为：

```text
B_b = Wneutral_b * Avatar.GetPostRotation(b)   // 除 Hips 外
B_Hips = identity  // glTF 模型轴：+X 向右、+Y 向上、+Z 向前
```

`Wneutral_b` 是 Unity Humanoid 解算后的骨世界旋转，在移除角色根的世界变换后表达于模型空间；
`Avatar.GetPostRotation(b)` 取自该骨已校准的 Unity Avatar，右乘在骨的旋转之后。Unity
[AvatarMuscleEditor.DrawMuscleHandle](https://github.com/Unity-Technologies/UnityCsReference/blob/master/Editor/Mono/Inspector/Avatar/AvatarMuscleEditor.cs)
也用 `t.rotation * avatar.GetPostRotation(humanId)` 表示该骨的关节轴框架。`B_b`
经统一坐标转换后成为 GLB 中性姿势下该核心骨的模型空间世界旋转；`Hips` 使用单位模型轴，
不使用其 postRotation。核心骨的参考局部旋转由本骨与其实际规范父骨
的 `B` 求得，通常不是单位四元数。核心骨的中性局部缩放为 1；骨长、关节锚点和模型比例由节点平移表达，
不能用修改骨轴改变 zero-muscle 中性姿势的物理几何。转换器须重算核心骨和辅助子节点
的局部 TRS、网格坐标表达及 skin inverse bind matrices，使中性外观和关节中心保持不变。

每个模型的 `B_b` 可以不同；统一的是 Unity Humanoid 解剖关节框架的生成规则和动作
数值语义，不是所有骨的世界旋转数值相同。左右肘、膝、手指和拇指的正负旋转方向须
逐骨验证；不能从子骨几何方向猜测或用来源游戏专用的运行时补丁校正。

## 5. 网格、蒙皮和绑定姿势

标准化须保持来源网格的有效蒙皮。顶点、法线、切线、Morph 增量和每个 skin joint
的绑定矩阵共同定义网格坐标与骨空间的关系；节点的标准中性姿势按照 §3、§4 表达。

来源网格的位置蒙皮采用线性混合时，对同一来源模型及已对应的骨骼姿势，标准化前后
同一顶点的一次线性混合结果须等价。权重及其 joint 对应关系必须保留；有骨合并或
重定向时，须满足 §6 的动态等价条件。共享动作的跨模型语义遵守 §8。

在已统一手系、长度单位和模型空间的前提下，定义：

- `I_j`：来源网格坐标到来源第 j 个骨绑定空间的矩阵；
- `N_j`：来源骨在 Unity zero-muscle 姿势中的有效模型空间矩阵；
- `C_j`：归一化后对应骨的中性模型空间矩阵；
- `C'_j`：归一化后该骨在当前动作帧中的模型空间矩阵。

保留来源顶点坐标时，每个 skin joint 的绑定矩阵为：

```text
I_normalized_j = inverse(C_j) * N_j * I_j
vertex_world = sum_j(weight_j * C'_j * I_normalized_j * vertex_source)
```

参考帧满足 `C_j * I_normalized_j = N_j * I_j`。对来源当前帧的有效骨矩阵
`N'_j`，动作换基还须满足 `C'_j * inverse(C_j) * N_j = N'_j`，才能保持该帧的
蒙皮结果。该条件须通过骨骼运动验证；参考帧的绑定等式不能代替动态验证。

辅助骨迁移、骨映射及来源缩放均须纳入上述有效矩阵。若为网格选择公共可逆坐标
变换 `T`，则顶点写为 `T * vertex_source`，绑定矩阵右乘 `inverse(T)`；位置 Morph
增量采用 `T` 的线性部分。法线和切线的空间适配须同时符合实际蒙皮与 Shader 的
输入语义。也可以采用经过逐顶点等价验证的坐标表达。

每个 skin slot 都有独立的绑定关系。只有对应动态变换及绑定关系均等价的 slot 才能
合并。组合头身或替换骨节点时，须把有效绑定关系转换到目标骨的中性空间。

产物验证必须覆盖：

- 中性帧的有效人体外观、关节中心和附件位置；
- 混合权重点在非端点动作下的位置，以及非零 Morph 与动作同时作用的结果；
- 左右肘、肩、腕和手指沿标准解剖方向的运动；
- 多个 SkinnedMeshRenderer、非单位 mesh 节点变换和非单位来源缩放；
- 骨合并、辅助骨迁移及头身组合后的有效蒙皮。

## 6. 非核心骨和附属结构

头发、衣服、裙摆、扭转骨、修形骨、挂点和面部骨不能简单丢弃。核心骨被改姿势、
改轴或改父级后，非核心骨必须同步迁移，使其在标准中性姿势下保持正确的解剖或
视觉关系。非核心骨若有独立动画，须按迁移后的父级和局部坐标框架重烘焙对应的
`groupTracks`；仅继承核心骨的运动不能代替其自身轨道。

若多个来源 skin joint 被合并或重定向到一个标准节点，实现必须证明它们在参考姿势
和动画姿势下的有效蒙皮变换等价。不能仅凭名称或父级接近就合并；脸不跟头、眼球
漂移和衣服撕裂都属于不合规。

## 7. Morph Target 和表情

表情继续使用 glTF morph targets 和 weights animation。若标准化改变网格坐标空间，
所有 morph target 的位置、法线和切线增量也必须采用与基础网格一致的空间适配。

静态 Morph 配方、独立配方系数及混合结果采用有限实数，允许负数和大于 1 的值；
播放器不隐式归一化或钳制。高层 blink/speech 输入及 visemes 的范围由 [表情标准](model_expression_spec.md) 规定。

标准姿势下权重为零时模型必须正确；应用任意表情后不得因身体标准化而出现脸部
漂移、裂缝或错误方向。

## 8. 与标准动作的接口

标准动作的 `tracks` 只按 HumanBodyBones 名称驱动核心骨。所有模型的旋转轨道必须使用
zero-muscle 中性姿势和 §4 的解剖关节坐标框架。普通骨骼不得使用来源模型的 local translation；`Hips`
位移必须使用标准定义的模型空间和尺度归一化方式。

`group` 只约束头身组合，不参与标准动作兼容性判定。标准动作可以另外携带由 `motionGroup` 限定的 `groupTracks`，驱动同一模型族共有的 Morph Target、非核心节点局部 TRS 或节点可见性。模型不声明匹配的 `motionGroup` 时不得应用这些轨道；这不影响标准 `tracks` 的播放。目标解析规则见[动作规范](standardized_motion_spec.md) §1.3。

从来源动画生成标准动作时，必须遵守 §3 的 Unity Humanoid 官方解算要求；播放器接收
的是已经解算并标准化的结果，不负责补偿转换器绕过 Humanoid 系统造成的误差。

播放器可以执行规范统一规定的坐标系转换和有效 `humanoidScale` 缩放，但不得读取来源
游戏标识来选择不同的旋转补丁。角色包不得要求注册游戏专用加载器、骨骼适配器或
渲染器分支；加入一个新游戏时，运行时代码应保持不变。

一份通用动作只烘焙一次即可驱动所有合规模型，不为每个模型另烘焙动作。骨长、比例
和蒙皮差异仍可能造成手部接触或脚底位置偏差；本契约不要求对每个目标 Avatar 逐帧
复现 Unity 原生重定向。脚底锁定、手部精确接触和角色世界位移可以属于更高层 IK 或
移动功能，不影响基础旋转兼容性的判定。

专属轨道的字段结构、采样方式和恢复行为由 [standardized_motion_spec.md](standardized_motion_spec.md) 定义。模型条目只描述自身 GLB，不复制动作轨道定义；同一资源包即使同时内聚动作条目，两者仍按各自类型独立解析。

## 9. 验证要点

检查最终渲染出的中性蒙皮姿势，而不只检查节点 TRS。使用同一份标准动作在不同骨长、
不同来源绑定姿势的模型上验证关节方向和蒙皮；同时检查头部附属结构与 Morph Target。
仅比较多个标准化模型之间的一致性可能掩盖共同的轴向错误，转换器还应与来源引擎
已解算的动作结果对照。手脚接触位置随骨长变化不构成违反本标准。

## 10. 不在本文范围

- 动作文件的具体 JSON schema；
- Shader 逆向和材质参数化渲染；
- Behavior 包的目录、JavaScript 模块接口与生命周期细节，见 [model_behavior_spec.md](model_behavior_spec.md)；
- 足底 IK、手部 IK、道具接触和角色世界位移；
