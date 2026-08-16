import sys

f = sys.argv[1]
content = open(f).read()

en_keys = """    'integration.obsidianSync': 'Obsidian Device Sync',
    'integration.obsidianSyncDesc': 'Sync your Obsidian notes with AgentWiki.',
    'integration.generateCode': 'Generate Connection Code',
    'integration.generating': 'Generating\u2026',
    'integration.connectionCode': 'Connection Code',
    'integration.copyCode': 'Copy',
    'integration.copied': 'Copied!',
    'integration.expiresIn': 'Expires in {minutes}:{seconds}',
    'integration.expired': 'This code has expired. Generate a new one.',
    'integration.connectSteps': 'To connect this device:',
    'integration.step1': '1. Open Obsidian \u2192 Settings \u2192 AgentWiki Sync',
    'integration.step2': '2. Server address: {origin}',
    'integration.step3': '3. Paste the code and click Connect',
    'integration.connectedDevices': 'Connected Devices',
    'integration.noDevices': 'No Obsidian devices connected yet.',
    'integration.deviceVault': 'Vault',
    'integration.lastUsed': 'Last used',
    'integration.never': 'Never',
    'integration.revoke': 'Revoke',
    'integration.revokeConfirm': 'Revoke this device? It will immediately lose access to all AgentWiki sync APIs.',
    'integration.revokeFailed': 'Failed to revoke device.',
    'integration.generateFailed': 'Failed to generate connection code. Please try again.',
"""

zh_keys = """    'integration.obsidianSync': 'Obsidian \u8bbe\u5907\u540c\u6b65',
    'integration.obsidianSyncDesc': '\u5c06 Obsidian \u7b14\u8bb0\u4e0e AgentWiki \u540c\u6b65\u3002',
    'integration.generateCode': '\u751f\u6210\u8fde\u63a5\u7801',
    'integration.generating': '\u751f\u6210\u4e2d\u2026',
    'integration.connectionCode': '\u8fde\u63a5\u7801',
    'integration.copyCode': '\u590d\u5236',
    'integration.copied': '\u5df2\u590d\u5236\uff01',
    'integration.expiresIn': '{minutes} \u5206 {seconds} \u79d2\u540e\u8fc7\u671f',
    'integration.expired': '\u8fde\u63a5\u7801\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u751f\u6210\u3002',
    'integration.connectSteps': '\u8fde\u63a5\u6b64\u8bbe\u5907\uff1a',
    'integration.step1': '1. \u6253\u5f00 Obsidian \u2192 \u8bbe\u7f6e \u2192 AgentWiki Sync',
    'integration.step2': '2. \u670d\u52a1\u5668\u5730\u5740\uff1a{origin}',
    'integration.step3': '3. \u7c98\u8d34\u8fde\u63a5\u7801\u5e76\u70b9\u51fb\u300c\u8fde\u63a5\u300d',
    'integration.connectedDevices': '\u5df2\u8fde\u63a5\u8bbe\u5907',
    'integration.noDevices': '\u5c1a\u672a\u8fde\u63a5 Obsidian \u8bbe\u5907\u3002',
    'integration.deviceVault': 'Vault',
    'integration.lastUsed': '\u6700\u540e\u4f7f\u7528',
    'integration.never': '\u4ece\u672a\u4f7f\u7528',
    'integration.revoke': '\u64a4\u9500',
    'integration.revokeConfirm': '\u786e\u5b9a\u64a4\u9500\u6b64\u8bbe\u5907\uff1f\u64a4\u9500\u540e\u5c06\u7acb\u5373\u5931\u53bb\u6240\u6709 AgentWiki \u540c\u6b65 API \u8bbf\u95ee\u6743\u9650\u3002',
    'integration.revokeFailed': '\u64a4\u9500\u8bbe\u5907\u5931\u8d25\u3002',
    'integration.generateFailed': '\u751f\u6210\u8fde\u63a5\u7801\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002',
"""

en_anchor = "    'integration.noCalls': 'No MCP calls have been recorded.',\n"
zh_anchor = "    'integration.noCalls': '\u5c1a\u672a\u8bb0\u5f55 MCP \u8c03\u7528\u3002',\n"

content = content.replace(en_anchor, en_anchor + en_keys)
content = content.replace(zh_anchor, zh_anchor + zh_keys)
open(f, "w").write(content)
print("i18n keys added")
