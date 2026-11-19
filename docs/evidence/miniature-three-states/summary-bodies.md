## ev-unpublished
- ready: false
- banner.level: warn
- banner.text: 任务已完成，但场景尚未发布：磁盘上没有 scene.json 清单。发布完成前无法预览或下载，这不等于生成失败。
- glb: null
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"failed","detail":"场景尚未发布（缺少 scene.json）"}
- synthetic: false
- error: 任务已完成，但场景尚未发布：磁盘上没有 scene.json 清单。发布完成前无法预览或下载，这不等于生成失败。

## ev-missing
- ready: false
- banner.level: error
- banner.text: 场景清单已发布，但清单声明的 GLB 资产文件缺失（资产文件不存在: room.glb），不能视为生成成功。
- glb: null
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"failed","detail":"清单声明的资产文件缺失：资产文件不存在: room.glb"}
- synthetic: false
- error: 场景清单已发布，但清单声明的 GLB 资产文件缺失（资产文件不存在: room.glb），不能视为生成成功。

## ev-invalid-path
- ready: false
- banner.level: error
- banner.text: 场景清单无法消费：资产路径非法: ../evil.glb。清单 schema 或资产路径非法，需修复清单后重新发布。
- glb: null
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"failed","detail":"清单 schema 或资产路径非法：资产路径非法: ../evil.glb"}
- synthetic: false
- error: 场景清单无法消费：资产路径非法: ../evil.glb。清单 schema 或资产路径非法，需修复清单后重新发布。

## ev-bad-schema
- ready: false
- banner.level: error
- banner.text: 场景清单无法消费：不支持的场景 schema: miniverse.scene-manifest.v0。清单 schema 或资产路径非法，需修复清单后重新发布。
- glb: null
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"failed","detail":"清单 schema 或资产路径非法：不支持的场景 schema: miniverse.scene-manifest.v0"}
- synthetic: false
- error: 场景清单无法消费：不支持的场景 schema: miniverse.scene-manifest.v0。清单 schema 或资产路径非法，需修复清单后重新发布。

## ev-ok
- ready: true
- banner.level: ok
- banner.text: 生成完成，可直接预览与下载。
- glb: {"url":"/api/reconstructions/ev-ok/scene/glb?asset=room","downloadUrl":"/api/reconstructions/ev-ok/scene/glb?asset=room&download=1","bytes":72,"sha256":null}
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"done","detail":"scene.glb"}
- synthetic: false

## fixture
- ready: true
- banner.level: ok
- banner.text: 生成完成，可直接预览与下载。
- glb: {"url":"/api/reconstructions/fixture-synthetic/scene/glb?asset=room","downloadUrl":"/api/reconstructions/fixture-synthetic/scene/glb?asset=room&download=1","bytes":1024,"sha256":"synthetic-not-a-real-hash"}
- export stage: {"key":"export","label":"导出 GLB","hint":"写出可下载的微缩模型","state":"done","detail":"scene.glb"}
- synthetic: true
