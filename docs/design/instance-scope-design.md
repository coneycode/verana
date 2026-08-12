# Instance Scope 设计 — 维度边界定义

## 问题

executor 在分 instance 收集证据时混入跨维度内容。如"组织架构与团队"文件里混入了商家数量、GMV数据、竞争策略等。

根因：instance 只有一个名称（如"组织架构与团队"），没有明确的边界定义。executor 不知道这个维度包含什么、不包含什么。

## 设计

### 1. instances 改为对象数组

现有：
```yaml
instances: ["组织架构与团队", "商家数量", ...]
```

改为：
```yaml
instances:
  - name: "组织架构与团队"
    scope: "组织架构演变、人员变动、团队规模、管理层信息"
    excludes: "GMV数据、商家数量、竞争策略、商业模式"
```

每个 instance 有：
- name: 维度名称（显示用）
- scope: 该维度包含什么（边界内）
- excludes: 该维度不包含什么（边界外，来自其他维度）

### 2. types.ts

```typescript
interface Instance {
  name: string;
  scope?: string;
  excludes?: string;
}
// CapabilityNode.instances 从 string[] 改为 Instance[]
```

### 3. Composer prompt 引导

prompt 里告诉 Composer：每个 instance 带 scope（包含什么）和 excludes（不包含什么，来自其他 instance 的维度）。

### 4. executeNode prompt 注入

现有：
```
本次处理实例: 组织架构与团队
```

改为：
```
本次处理实例: 组织架构与团队
该维度范围: 组织架构演变、人员变动、团队规模、管理层信息
不要包含: GMV数据、商家数量、竞争策略、商业模式
```

### 5. 兼容性

旧 spec 的 instances 是 string[]。在 assembleSpec 里检测：如果 element 是 string，自动转成 { name: string }（scope/excludes 为空）。

### 6. validator

instances 校验不变——只检查 length > 0 和 {instance} 占位符。不强制要求 scope/excludes（prompt 引导，不是硬约束）。

### 7. 前端

buildCapabilityGraph 里 instance 显示从 `c.instances[i]` 改为 `c.instances[i].name`（如果是对象取 .name，如果是 string 直接用）。

timeline block 的 instance 标注同理。

## 改动文件

1. types.ts — Instance 接口，CapabilityNode.instances 改类型
2. pipeline.ts — assembleSpec 转换，Composer prompt 引导
3. graph-engine.ts — executeNode prompt 注入 scope/excludes
4. app.js — 显示 instance.name
5. workflow-validator.ts — 兼容 string[] 和 Instance[]
