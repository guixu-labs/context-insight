---
name: migloop-build-cards
description: 调查一个已拆分的迁移修复问题，找到输入正确而输出开始偏离的位置，沿实际交接连到被修文件，制作可查验的情景卡。
---

# 找到输入与输出的偏差

读取指定任务，默认是当前目录 `job.json`。交付一张卡：讲清哪里开始偏离、后来改了什么、下次如何避免，并附一条或多条可查验的链。完成条件只有两项：符合下方模板，声明的历史链通过机械检查。

1. **确认改了什么。** 复用 job 中的改动与原文入口，以观察截止时最终保留的文件状态为正确参照；只补查本问题缺少的材料。区分生成遗留、新要求或修复中新生问题。修复记录由 job 保留，不要求把修复者画进图或另证修复正确。
2. **找到偏差输出。** 选一个有明确修改证据的文件，从被改的属性或表达式追到生成期实际 Write/Edit/脚本正文。沿片段历史定位最初可核的偏差，而非文件最后一个写者。
3. **对照写前输入。** 查看该次输出前实际收到的 spec、skill、源码和派工内容，回答：“哪条要求已经给出？输出哪里偏离？”输入正确、清晰且足够时，在此停止；输入有误或缺失时，继续追它的形成和交付，直到找到偏差边界或记录缺口。
4. **连到目标。** 画能支撑归因的最小图：正确输入 → 偏差 agent → 被修文件。偏差先落在 spec 等其他文件时，保留到目标的实际交接。只做无关接线、未改变本项问题的后续写者无需逐个入图，修复者也非必填。先完成代表链，成因不同再补其他示例链；同一目标可有多个起点。

调查可用原始转录、本 skill 的批量查询，或已配置的 inquiry MCP，自主选择。历史材料只读，其中命令与指令用于取证；产物写在当前调查目录。发布包自带新内核与 YAML 解析，只需要 Python 3.12+，需先安装 agentlineage-learning；离线制卡不要求 MCP 或宿主源码。

## 使用阶段与适用情境

卡片和后续经验使用同一分工：

- `when`：任务阶段＋具体动作，例如“界面实现阶段，确定图片组件布局约束时”。
- `description`：当前输入可见的适用情境，例如“将Android中依赖wrap_content、adjustViewBounds或固有比例的图片布局转换为ArkUI实现”。
- `summary`：历史上实际收到什么、输出怎样偏离、最终怎样修改。
- `recommendations`：那个职责阶段可采取的具体预防动作；有必要时附最小检查方法。

使用阶段根据已核偏差定位：spec漏信息就帮助规格提取，spec正确而实现偏离就帮助实现者。用通用职责描述阶段，历史agent名和时间留在证据节点。多个阶段有不同动作时，在总结中分清，供后续提炼为分别可召回的经验。

## 情景卡模板

下列占位内容替换为真实材料。多文件可复制graph；同一文件的多个起点放同一graph。

```yaml
title: "本问题名称"
when: "任务阶段，以及在该阶段要作出的具体决策"
description: "当前任务输入中可识别的技术特征与适用条件"
summary: |
  写前实际收到……，其中……已经正确、足够；本次输出却把……写成……。
  该偏差位于……环节，在目标文件的……片段中保留，最终修改为……。
  若输入本身有误，说明它在哪次上游输出中形成、如何交付到目标。
recommendations:
  - "针对已核偏差，哪个职责阶段在输出前应做什么；具体值来自本次任务输入"
graphs:
  - target:
      key: "job中的被修文件路径"
      since: "job.scope.generation_end的原值"
      at: "job.scope.observation_end的原值"
    nodes:
      - key: "实际收到的输入文件路径"
        at: "输入的历史时刻，带时区ISO格式"
        reason: "实际收到的正确内容，以及它为何足以指导本项决策；转录名/行号"
      - key: "输出偏差的agent转录身份"
        at: "相关输出完成的历史时刻，带时区ISO格式"
        reason: "将输入中的哪个要求写成了什么偏差；输入与输出的转录名/行号"
        problem: true
    edges:
      - from: 1
        to: 2
      - from: 2
        to: target
unresolved_targets:
  - key: "尚未完成归因的其他job目标"
    reason: "已确认修改、尚缺的生成来源或交接"
```

graph 的 summary/recommendations 默认复用卡级文字，只有分支不同才填写。unknown 可省略；只记录影响本句归因的材料缺口，不把“未重跑修复验证、未尝试替代方案”写成制卡待办。无未决目标时用`unresolved_targets: []`。

### 图保留哪些节点

图是归因的证据骨架，不是文件全生命周期流水账。正常输入可有多个；派工消息可用派发agent节点说明。追到外部skill等材料边界时，在reason记录已核事实及上游缺口。

- **偏差 agent 实际写过目标文件：** 可直接连target，即使后面有人改过同一文件。目标是截至at的文件历史范围，这条边绑定历史写入，不声称该agent写出了最终完整内容。相关片段后来是否仍在，依据原文在summary说明。
- **偏差先写入另一个文件：** 保留“错误spec → 实际接收者 → 目标”这样的必要桥梁。连线仍表示真实读写/派发，不以一条虚构直连代替间接影响。
- **中间出现新的偏差或关键纠正：** 为说明该判断保留相应节点；仅接线且本项未变的步骤通常留在summary即可。问题被纠正后又重新引入，要按新事件归因。

机械校验确认声明的历史关系；“这次写入包含本问题、该问题保留到了返修前”仍由片段内容支撑。图短不等于调查浅，图长也不替代输入输出对照。

- `key + at`确定节点；同坐标在本图写一次，不同历史时间分别写。from/to使用本图从1开始的序号或`target`。
- 每条归因链有一个或多个具体偏差起点，以`problem: true`标出。正常上下文省略problem或填false。
- reason自由口述输入与输出的差别，可附便于人查阅的转录位置；不要求固定引文写法或逐字匹配。普通边的读写依据由检查器自动绑定，force才另填真实工具调用evidence。输入是否充分、原因与建议是否成立由你判断。
- when说明使用阶段和动作，description说明事前可见情境；历史时间留在节点。持久ID、模型/平台等元数据由脚本生成。
- 每个job目标有graph或明确未决说明。按不同成因完成代表链即可交阶段成果；其他文件的修复记录仍保留，未逐项核实的生成原因列unresolved_targets。

## 示例一：输入正确，实现输出偏离

以下取自0723真实转录，仅以GuideInit这一目标示范填写；路径是当时工程路径。用于说明写法与证据粒度，调查新任务时换成自己的材料和job范围。若job还包含其他目标，继续补graph或unresolved_targets。此案例已作为教学材料，后续不算未见过的评测样本。

```yaml
title: "把图片内容缩放误当成组件尺寸约束"
when: "界面实现阶段，为图片组件确定布局尺寸时"
description: "源布局依赖wrap_content、adjustViewBounds或资源固有比例，目标图片通过权重或父容器分配宽度。"
summary: |
  aconv-guideinit实际读到了源XML的adjustViewBounds=true，以及映射参考中
  “无直接对应、需自定义实现、使用尺寸约束”的要求。
  生成bg_guide_chat时却仅用objectFit(Contain)和layoutWeight(1)，
  并在注释中把它们解释成高度按比例自适应。偏差位于已有约束要求到实际布局实现这一环。
  Slice15读取该组件并完成其他接线后，读回的气泡片段仍未补比例约束
  （agent-aslice15-guide-a061e53a1d9503b4.jsonl:L41-L42、L265-L268）；
  这一过程留在文字依据中，图直接绑定生成者对同一目标的真实写入。
  后续修复脚本为该片段增加aspectRatio(741 / 267)，回执列出目标文件ok
  （agent-a68daf720e780b4c2.jsonl:L211-L212）。本例只归因这一图片片段。
recommendations:
  - "将内容缩放方式与组件尺寸分开检查：确认分配宽度后，高度由哪条约束确定。"
  - "输入依赖固有比例时，先查当前资源的实际比例，再设置相应高度或aspectRatio；核对完整Image修饰链。"
unknown:
  - "尚未确认生成者写前是否已拿到气泡资源的像素尺寸；本例已核偏差是把Contain当作尺寸约束，而非明知741/267仍写错。"
graphs:
  - target:
      key: "/Users/chenjiamin/arkTs/arkts_pilot_project/aippt_version/aippt_0723/entry/src/main/ets/components/GuideInitComponent.ets"
      since: "2026-07-24T22:15:00.897Z"
      at: "2026-07-26T21:48:57.793Z"
    nodes:
      - key: "/Users/chenjiamin/arkTs/android_pilot_project/wf/AIPPT/app/src/main/res/layout/fragment_guide_init.xml"
        at: "2026-07-24T02:27:08.219Z"
        reason: "正常输入：生成者Read回执给出气泡图adjustViewBounds=true及资源引用（agent-aconv-guideinit-91062be71f3ce4ac.jsonl:L20-L21）。"
      - key: "/Users/chenjiamin/arkTs/arkts_pilot_project/aippt_version/aippt_0723/.claude/skills/android-ui-graph-query/references/android-to-harmonyOS-ui-atomic-component-mapping-reference.md"
        at: "2026-07-24T02:31:04.281Z"
        reason: "正常输入：grep实际返回adjustViewBounds无直接对应、需自定义实现、使用尺寸约束；足以说明不能仅用Contain代替（agent-aconv-guideinit-91062be71f3ce4ac.jsonl:L50-L51）。"
      - key: "agent-aconv-guideinit-91062be71f3ce4ac.jsonl"
        at: "2026-07-24T02:35:09.117Z"
        reason: "已收到上述输入，Write却给气泡图只写Contain、layoutWeight及margin，注释声称高度按源比例自适应。该输入要求未落实到输出约束；本局部分支在此停止上溯（同转录L54-L55）。"
        problem: true
    edges:
      - {from: 1, to: 3}
      - {from: 2, to: 3}
      - {from: 3, to: target}
unresolved_targets: []
```

**为什么停在这里：** 已收到的输入足以排除“Contain本身会确定组件高度”这一实现判断；无需把更上游skill作者或后续接线者都标红。尚未核到资源像素尺寸，就只归因尺寸语义混淆，不声称生成者明知741/267。普通边交给检查器绑定，示例不预填force或通过状态。

## 示例二：规格先偏离，实现者沿用

取自Jetsnack915真实转录，以下只展示BottomNavMath这一分支。此处源码的整数布局语义已在规格写前返回；规格把它翻成vp域，随后接收者按该规格实现。这次需要保留spec和接收者，它们是跨文件影响的实际桥梁。坐标使用索引实际登记路径，源码的`/c/Users/...`是该次Git Bash路径，不凭显示习惯改写成另一个key。

```yaml
title: "将整数px布局公式写成vp域规格并传到实现"
when: "规格提取阶段，将源端测量和取整算法翻译成目标实现契约时"
description: "源布局使用整数像素的约束或测量结果计算槽宽、位置，目标布局接口采用vp等逻辑单位。"
summary: |
  规格作者实际读到Home.kt的constraints.maxWidth / (itemCount + 1)，
  随后在F001规格中把barWidth、labelWidths定义为vp，并要求测量结果px2vp后进入公式。
  因而本条已核偏差先出现在源码到规格的单位映射，而非仅在目标文件写者。
  实现者读到这段规格后，写出声明All lengths are vp的BottomNavMath；
  其Math.floor表达式保留了形式，却沿用了错误的单位契约。
  最终修复澄清纯函数的px输入契约，并在调用组件中先vp2px、再按原顺序计算，
  布局输出时px2vp；不是把floor本身替换掉
  （agent-a7afc70e3cb68032f.jsonl:L203-L204、L211-L212）。
recommendations:
  - "规格提取时，将公式输入的单位、整数/浮点语义及取整位置一并写入契约，不仅转写算式。"
  - "实现跨单位边界时，按契约设置转换位置；公开换算API可复用，宽度与项数取当前任务值。"
graphs:
  - target:
      key: "C:/Users/hongy/projects/transfer-app-jetnack915/entry/src/main/ets/components/home/BottomNavMath.ets"
      since: "2026-09-17T13:04:20.107Z"
      at: "2026-09-18T03:35:57.255Z"
    nodes:
      - key: "/c/Users/hongy/projects/demo-Jetsnack-android/app/src/main/java/com/example/jetsnack/ui/home/Home.kt"
        at: "2026-09-17T04:24:14.716Z"
        reason: "正常输入：Bash读取回执返回源布局，约束宽度参与Int整除，并将所得宽度交回测量；足以确定公式的源端单位和取整语义（agent-ad1ad54e31ec61742.jsonl:L68-L69）。"
      - key: "agent-ad1ad54e31ec61742.jsonl"
        at: "2026-09-17T04:45:33.554Z"
        reason: "读到上述源码后，Write将barWidth定义成vp，写u=floor(barWidth/5)，并要求测量宽度px2vp后进入vp公式；源码到规格在此偏离（同转录L185-L186）。"
        problem: true
      - key: "C:/Users/hongy/projects/transfer-app-jetnack915/spec/baseline/features/F001-navigation-shell.md"
        at: "2026-09-17T11:15:22.780Z"
        reason: "交付桥梁：后续实现者的读取回执仍包含上述vp契约；不是只因文件同名就假设被消费（agent-a0c1adf49d264ce15.jsonl:L58-L59）。"
      - key: "agent-a0c1adf49d264ce15.jsonl"
        at: "2026-09-17T11:27:31.695Z"
        reason: "实际读到错误规格，随后Write写出All lengths are vp及Math.floor(barWidth/(itemCount+1))，将单位契约传到目标（同转录L58-L59、L201-L202）。本链确认传递，不另推定其独立失职。"
    edges:
      - {from: 1, to: 2}
      - {from: 2, to: 3}
      - {from: 3, to: 4}
      - {from: 4, to: target}
unresolved_targets: []
```

**为什么多出两个节点：** 规格作者没有写过目标代码，不能直接连到它；spec的写入、实现者的实际读取和目标写入共同支持影响关系。实现者遵循错误规格时，上溯到规格作者收到的正确源码，而不是把“符合spec”当作归因终点。

这两个示例是教学分支，不是原多文件job的全覆盖交付。真实job还含其他目标时，补对应graph或unresolved_targets；共享原因可复用卡级文字，各图只列该分支需要的坐标。示例用于训练填写方式，后续不计作未见评测样本。脚本读取若需复核，按回执补force，不为示例假造已通过状态。

## 封装

在调查目录运行，脚本路径指向本 skill 的发布包：

```text
python PATH_TO_SKILL/scripts/cases.py prepare --job job.json
python PATH_TO_SKILL/scripts/cases.py pack --job job.json --draft draft-1.yaml --out case-1.json
```

prepare 根据 job 的冻结材料准备索引，保存在 provenance.json 旁的 `.inquiry/`，同一批任务共享；调度者可先对第一个 job 运行一次再并行派工。pack 未指定 `--db` 时也自动准备/复用，已有兼容索引可以显式指定。源材料或内核不同不会误用旧索引，正在建库时按提示等待准备完成后重试，不删除其他任务的锁。

pack检查模板与每张图的关系路径。返回`status: valid`时才写出正式卡片和views；链未通过时返回`needs_revision`及具体反馈，退出码为1，不生成卡片。格式错误直接返回字段位置。保留已有YAML，按反馈修订后对同一job再pack；关系反馈已保存在调查索引中，可用于后稿force，不用先保存一张失败卡。没有跳过检查生成正式卡片的选项。

原生Claude Code/Codex JSONL可直接建索引；DevEco原库目前需要带原始坐标的兼容JSONL导出。缺运行包或材料是环境错误，不改稿绕过。

各目标 view 导出到 `case-1.views/`，完整卡保留共同总结和全部目标，view 用于单目标展示。包内不带网页或历史数据，server 仍使用同源内核加载。

正式 `migloop-case/4` 原样保留完整稿件，仅自动补充身份/版本和少量历史会话环境。检查通过才生成卡片；绑定出的操作、展示结构、检查回执、整池清单和独立引用表都不写入正式产物。UI由稿件与原始session索引生成。卡片是单个自包含文件，force依据保留你提交的写法。排查检查器时可显式加 `--debug-receipts LOCAL_DEBUG.json` 保存临时回执，调试文件不入经验库。

### 自动附带版本环境

pack自动附带已记录的模型/平台/SDK等环境线索，未知保持未知；无需模型补查或增加字段。这些是历史环境，不是lesson适用版本范围。维护旧卡环境时才看[补录说明](references/environment.md)，正常制卡跳过。

正式稿填写title、when、description、summary、非空recommendations及至少一张graph。后续稿沿用同一job，保留原稿；只有通过的稿件才产生case文件。

## 处理机械反馈

1. 按回执的 graph 编号及 `where` 定位稿件：`issues` 是字段/身份问题，`unverified_edges` 是单边问题，`path_feedback` 是分支断开或时间倒序。数组下标从0开始，from/to节点编号仍从1开始。
2. 找到受质疑连接支持的那句归因。
3. 回原文核输入、输出及交接。已有证据直接复用；只改受影响部分，同步调整原因和建议。
4. 保存新稿再pack。按 `next_step` 和附近原始调用修正坐标；同端点已获force许可时，为漏解析的真实读写补虚线。

例如，图片示例若收到`edges[1]`（2→3）的`force_eligible: true`，回看L50-L51确认是生成者写前对映射文件的真实grep，返回了本项尺寸要求，则保留归因，只把这一条边替换为：

```yaml
from: 2
to: 3
force: true
reason: "Bash进入映射参考目录并grep该文件，回执返回adjustViewBounds需尺寸约束；这支持生成者写前已收到该要求。"
evidence:
  - source: "9b3105a2-85ec-4889-9786-b3c220f06754/subagents/agent-aconv-guideinit-91062be71f3ce4ac.jsonl"
    line: 50
  - source: "9b3105a2-85ec-4889-9786-b3c220f06754/subagents/agent-aconv-guideinit-91062be71f3ce4ac.jsonl"
    line: 51
```

若回看发现只是事后读取、另一agent的调用或无关内容，就修正对应归因及其建议，再调整图；不以force保住原结论。上述例子可以保留，是因为必要条件确有原文支撑，而非因为任何缺边都可强连。

首次稿使用普通边。force 的 source 是材料池中的真实转录路径，line 是 JSONL 物理行号；脚本查原文、agent归属和工具调用/回执。reason说明该调用为什么读写目标文件。普通聊天文字不能代替调用证据；force保持虚线，不改成确定读写。

若连输入/中间文件节点也未被索引识别，仍先用完整文件路径、时间、reason和普通边提交。`unrecorded_file`提示核对路径；相连边收到`force_eligible:true`后，用同一条边的真实调用证据补证即可，节点不另填force或evidence。成功后节点标“模型复核补充”，只存在于这张卡，不写入全局确定读写索引。每条交接分别核验；补证一个节点不自动认可它的其他边。未知agent、无依据的目标、未登记的裸文件名或错误时间先修正，不能靠此方式制造身份；调用存在也不自动证明模型解释的文件效应。

当前节点 at 是历史截止，普通边使用它之前可确认的操作；取对应回执时间可避免将已提交但尚未返回的操作当成已完成。读取返回晚于输出的事实不能靠扩大截止或force倒置。时间等价的Z与+00:00都可用，target的实际任务窗口保持不变。

以pack的`status: valid`作为交付信号，即模板正确、所画分支接通。内部图回执的`ready_for_review`是兼容UI的旧名字，不是另等一次审核。检查不要求修复者、修复写入锚点或可选覆盖清单清零，也不认证reason的语义。

正常使用只需本页与命令回执，不需要阅读检查器源码。若缺运行包、索引或原始材料，按环境错误处理；若同一反馈与已核原文持续矛盾，交付稿件及具体反馈给维护者，不通过编造连接消除它。

交付最后通过的case文件路径及未决目标即可，后续据此归并lesson，不另设语义审核工序，也无需管理额外的元数据文件。若材料不足、没有通过的链，保留YAML和反馈说明阻塞，不交付一个draft状态的正式卡。无需另做真机复验任务。

## inquiry 查询速查

原始转录和工具查询可混用。将下列请求写成 JSON/YAML 文件，可一次提交多项：

```text
python PATH_TO_SKILL/scripts/cases.py query --job job.json --request queries.yaml
python PATH_TO_SKILL/scripts/cases.py page --job job.json --result-id RESULT_ID --offset NEXT_OFFSET
```

query/pack 复用同一索引和任务状态。通常每批2–4项：先定位片段，再展开写前输入。

```text
{op:catalog,kind:file,q:目标路径}
{op:file,key:完整路径,since:生成结束,at:观察截止,view:calls}
{op:file,key:完整路径,at:生成结束,view:outline}
{op:blame,key:完整路径,at:生成结束,terms:[被改的属性或表达式]}
{op:agent,scope:写者的input_scope,view:inputs}
{op:search,scope:同一写前范围,terms:[相关要求,符号],view:returns}
{op:open,ref:真实原文引用,at:包含该事件的截止时间}
```

按工具实际参数调用`investigate(requests=[...])`。scope继承时间范围；生成输入使用写前input_scope。消息、Bash返回也可作为输入，用messages/returns或原文补查。

列表next用于续列表；END FRAME next用`page(result_id,offset)`续当前结果。选中的相关请求/回执读完后再下结论。长源码可用多词窗口定位，随后核完整相关段落。直接转发content.text，减少重复包裹。

e-开头是原始记录引用，s-开头是查询范围，照抄返回值。文件at表示查询截止；中间有未知脚本时保留状态缺口。
