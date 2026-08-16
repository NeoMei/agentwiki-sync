import sys

f = sys.argv[1]
content = open(f).read()

# 1. Add imports
old_import = "import { AlertCircle, CheckCircle, Plug } from 'lucide-react';"
new_import = "import { AlertCircle, CheckCircle, Plug, BookOpen, Copy, X } from 'lucide-react';"
content = content.replace(old_import, new_import)

# 2. Add state and hooks after existing useState
old_state = "  const [error, setError] = useState<string | null>(null);"
new_state = """  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [codeData, setCodeData] = useState<{ code: string; expiresAt: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [countdown, setCountdown] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    api.get('/integrations/obsidian/credentials')
      .then((response) => setDevices(response.data?.credentials ?? []))
      .catch(() => setDeviceError(t('integration.generateFailed')));
  }, []);

  useEffect(() => {
    if (!codeData) return;
    const update = () => {
      const ms = new Date(codeData.expiresAt).getTime() - Date.now();
      if (ms <= 0) { setCountdown(t('integration.expired')); return; }
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      setCountdown(t('integration.expiresIn', { minutes: String(minutes).padStart(2, '0'), seconds: String(seconds).padStart(2, '0') }));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [codeData]);

  const generateCode = async () => {
    setGenerating(true);
    setCodeCopied(false);
    try {
      const response = await api.post('/integrations/obsidian/installations');
      setCodeData({ code: response.data.code, expiresAt: response.data.expiresAt });
    } catch {
      setDeviceError(t('integration.generateFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = async () => {
    if (!codeData) return;
    try {
      await navigator.clipboard.writeText(codeData.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch { /* clipboard may be unavailable */ }
  };

  const revokeDevice = async (credentialId: string) => {
    if (!window.confirm(t('integration.revokeConfirm'))) return;
    setRevokingId(credentialId);
    try {
      await api.delete(`/integrations/obsidian/credentials/${credentialId}`);
      setDevices((prev) => prev.filter((d) => d.credentialId !== credentialId));
    } catch {
      setDeviceError(t('integration.revokeFailed'));
    } finally {
      setRevokingId(null);
    }
  };"""
content = content.replace(old_state, new_state)

# 3. Insert Obsidian section before agent access heading
old_agent = "          <h3 className=\"font-medium mt-5 mb-2\">{t('integration.agentAccess')}</h3>"
obsidian_section = """          {/* Obsidian Device Sync */}
          <div className=\"border-t pt-5 mt-8\">
            <div className=\"flex items-center gap-3 mb-4\">
              <div className=\"w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center\"><BookOpen size={20} /></div>
              <div className=\"flex-1\">
                <h2 className=\"font-semibold\">{t('integration.obsidianSync')}</h2>
                <p className=\"text-sm text-gray-500\">{t('integration.obsidianSyncDesc')}</p>
              </div>
              <button
                onClick={generateCode}
                disabled={generating}
                className=\"px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50\"
              >
                {generating ? t('integration.generating') : t('integration.generateCode')}
              </button>
            </div>

            {codeData ? (
              <div className=\"border rounded-lg p-4 bg-blue-50 mb-4 relative\">
                <button
                  onClick={() => setCodeData(null)}
                  className=\"absolute top-2 right-2 text-gray-400 hover:text-gray-600\"
                >
                  <X size={16} />
                </button>
                <p className=\"text-sm font-medium mb-2\">{t('integration.connectionCode')}</p>
                <div className=\"flex items-center gap-2\">
                  <code className=\"flex-1 text-sm bg-white border rounded px-3 py-2 font-mono break-all\">{codeData.code}</code>
                  <button
                    onClick={copyCode}
                    className=\"shrink-0 px-3 py-2 text-xs font-medium text-blue-700 bg-white border rounded hover:bg-blue-50 flex items-center gap-1\"
                  >
                    <Copy size={14} />
                    {codeCopied ? t('integration.copied') : t('integration.copyCode')}
                  </button>
                </div>
                <p className=\"text-xs text-amber-700 mt-2\">{countdown}</p>
                <div className=\"mt-3 text-xs text-gray-600 space-y-1\">
                  <p className=\"font-medium\">{t('integration.connectSteps')}</p>
                  <p>{t('integration.step1')}</p>
                  <p>{t('integration.step2', { origin: window.location.origin })}</p>
                  <p>{t('integration.step3')}</p>
                </div>
              </div>
            ) : null}

            <h3 className=\"font-medium mt-4 mb-2\">{t('integration.connectedDevices')}</h3>
            {deviceError ? <p className=\"text-sm text-red-600 bg-red-50 rounded-lg p-3 mb-2\">{deviceError}</p> : null}
            <div className=\"space-y-2\">
              {devices.length ? devices.map((device) => (
                <div key={device.credentialId} className=\"border rounded-lg p-3 flex items-center gap-3\">
                  <div className=\"flex-1 min-w-0\">
                    <div className=\"flex items-center gap-2\">
                      <span className=\"font-medium text-sm\">{device.deviceName}</span>
                      <span className={\"text-xs \" + (device.status === 'active' ? 'text-green-700' : device.status === 'provisional' ? 'text-blue-700' : 'text-gray-400')}>{device.status}</span>
                    </div>
                    <p className=\"text-xs text-gray-500 mt-1\">
                      {t('integration.deviceVault')}: {device.vaultId?.slice(0, 8)}\u2026 \u00b7 {t('integration.lastUsed')}: {device.lastUsedAt ? new Date(device.lastUsedAt).toLocaleString(language) : t('integration.never')}
                    </p>
                  </div>
                  <button
                    onClick={() => revokeDevice(device.credentialId)}
                    disabled={revokingId === device.credentialId || device.status === 'revoked'}
                    className=\"shrink-0 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50\"
                  >
                    {revokingId === device.credentialId ? '\u2026' : t('integration.revoke')}
                  </button>
                </div>
              )) : <p className=\"text-sm text-gray-500 border rounded-lg p-3\">{t('integration.noDevices')}</p>}
            </div>
          </div>
"""
content = content.replace(old_agent, obsidian_section + "          " + old_agent.strip())

open(f, "w").write(content)
print("IntegrationsPage updated")
