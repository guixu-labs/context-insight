# 已有卡片的环境补录（维护操作）

正常制卡的pack已自动补环境，调查员无需运行这里的命令。

需要给旧卡补录SDK/API等历史环境时，使用同池重新采集的metadata：

```text
python PATH_TO_SKILL/scripts/cases.py enrich --cards CASE_A.json CASE_B.json --metadata METADATA.json --out NEW_CARDS
```

enrich核对材料指纹，按卡片观察截止提取已记录环境，写入新目录；原稿、claims、图和原校验回执保持原样。它不会重新校验图，也不会把失败卡变成有效卡。旧卡若未通过当前交付条件，先用原job和YAML执行pack。

环境来源是历史配置调用和成功回执，未知保持未知；不读当前工程配置、不运行构建或设备测试。BOM不等于实际解析的库版本，target SDK不等于编译或运行设备版本；记录到的版本不是经验的跨版本适用范围。

卡片版本变化后，按正常ingest/apply更新来源绑定，再export阅读目录。无需让调查员为环境补录重新归因。
