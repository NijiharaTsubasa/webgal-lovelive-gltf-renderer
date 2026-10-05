# 统一资源包清单规范

本文规定模型、Shader、Behavior 及其他组件资源共用的 `config.json`
外层结构。各资源类型的专有字段由对应规范定义。

标准动作以自包含的 `.json` 或 `.motionbin` 文件交付，字段与编码见
[标准动作规范](standardized_motion_spec.md) §1。

参数动作以 `.mtn` 文件、参数表情以 `.exp.json` 文件交付，格式与适配器声明见
[参数驱动动作与表情规范](parameter_driven_animation_spec.md)。

## 1. 清单结构

`config.json` 根对象只能包含一个 `components` 数组：

```json
{
  "components": [
    {
      "type": "model", "name": "character", "role": "integrated", "model": "model.glb",
      "morphPoses": [], "expressionGroups": [], "humanoidScale": 1
    },
    {
      "type": "shader", "name": "toon", "src": "shaders/toon.glsl",
      "samplers": [], "passes": [{ "id": "Forward", "sections": {} }]
    }
  ]
}
```

每个条目必须是对象，并携带非空字符串 `type`。一个清单可以包含任意数量、任意
组合的资源类型。同处一个清单只表示这些文件作为一个自包含目录交付，不隐含资源
之间的兼容性、依赖、选择关系或执行顺序。

`components` 可以为空，表示目录当前没有已声明的资源。

包内相对路径均以所在 `config.json` 的目录为基准，解析后必须仍位于该目录内；
绝对路径、URL 和包含 `..` 的逃逸路径非法。

## 2. 发现与分派

加载器可发现 `config.json`，再逐项按 `components[].type` 分派给对应资源模块。
清单条目必须自行携带识别和加载该资源所需的元数据。

未知 `type` 不影响同包已支持条目的解析；加载器可以跳过未知条目。

## 3. 身份与冲突

各类型身份由对应资源规范定义；同一清单不得出现重复的同类型身份。

安装后的资源集合若出现全局唯一类型的身份冲突，加载器不得
按扫描顺序覆盖或任选。
