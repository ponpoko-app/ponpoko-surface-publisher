import { useCallback, useEffect, useState } from "react";
import {
  cloudAccount,
  githubConnect,
  githubDisconnect,
  githubStatus,
  listSources,
  pickSource,
  preparePackage,
  prepareSource,
  publishPackage,
  publishSource,
  scanSecurity,
  type PublisherClient,
} from "./client";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PackagePrepareResult,
  PublishPackageResult,
  PublishSourceResult,
  SecurityScanResult,
  SourcePrepareResult,
} from "../shared/types";

type ShareMode = "use_only" | "open_source";

function statusLabel(status: LocalSurfaceSource["status"]): string {
  if (status === "draft") return "Draft (รอปรับใช้)";
  if (status === "installed") return "Installed";
  return "Registered";
}

export function App({ client }: { client: PublisherClient }) {
  const [sources, setSources] = useState<LocalSurfaceSource[]>([]);
  const [selected, setSelected] = useState<LocalSurfaceSource | null>(null);
  const [scan, setScan] = useState<SecurityScanResult | null>(null);
  const [gh, setGh] = useState<GitHubStatus>({ connected: false, username: null, source: "none" });
  const [ownerAccount, setOwnerAccount] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [mode, setMode] = useState<ShareMode>("use_only");
  const [repoInput, setRepoInput] = useState("");
  const [notes, setNotes] = useState("");
  const [prepared, setPrepared] = useState<PackagePrepareResult | SourcePrepareResult | null>(null);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState(false);
  const [confirmRemote, setConfirmRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishPackageResult | PublishSourceResult | null>(null);

  useEffect(() => {
    return client.onPalette((tokens) => {
      const root = document.documentElement.style;
      if (tokens.bg) root.setProperty("--bg", tokens.bg);
      if (tokens.surface) root.setProperty("--surface", tokens.surface);
      if (tokens.border) root.setProperty("--border", tokens.border);
      if (tokens.fg) root.setProperty("--fg", tokens.fg);
      if (tokens.fgMuted) root.setProperty("--fg-muted", tokens.fgMuted);
      if (tokens.accent) root.setProperty("--accent", tokens.accent);
    });
  }, [client]);

  const resetReview = useCallback(() => {
    setPrepared(null);
    setAcknowledgedWarnings(false);
    setConfirmRemote("");
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [foundSources, status, account] = await Promise.all([
        listSources(client),
        githubStatus(client),
        cloudAccount(client).catch(() => ({ accountId: null })),
      ]);
      setSources(foundSources);
      setGh(status);
      if (account.accountId && !ownerAccount) {
        setOwnerAccount(account.accountId);
      }
      if (foundSources.length > 0 && !selected) {
        setSelected(foundSources[0]);
        setRepoInput(`ponpoko-${foundSources[0].id}`);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [client, ownerAccount, selected]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selected) {
      setScan(null);
      return;
    }
    let cancelled = false;
    setScan(null);
    setPublished(null);
    setError(null);
    resetReview();
    void scanSecurity(client, selected.sourceId)
      .then((result) => {
        if (!cancelled) setScan(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, resetReview, selected]);

  const handleConnect = async () => {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await githubConnect(client, tokenInput);
      setGh(next);
      setTokenInput("");
      resetReview();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePickSource = async () => {
    setBusy(true);
    setError(null);
    try {
      const sourceId = await pickSource(client);
      if (!sourceId) return;
      const updated = await listSources(client);
      const registered = updated.find(source => source.sourceId === sourceId);
      setSources(updated);
      if (!registered) throw new Error("ไม่พบโฟลเดอร์ที่เพิ่งลงทะเบียนในรายการ");
      setSelected(registered);
      setRepoInput(`ponpoko-${registered.id}`);
      resetReview();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePrepare = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setPublished(null);
    resetReview();
    try {
      if (mode === "use_only") {
        const res = await preparePackage(client, {
          sourceId: selected.sourceId,
          repo: repoInput.trim() || undefined,
          notes: notes.trim() || undefined,
          ownerAccount: ownerAccount.trim() || undefined,
        });
        setPrepared(res);
        setScan(res.scan);
      } else {
        const res = await prepareSource(client, {
          sourceId: selected.sourceId,
          repo: repoInput.trim() || undefined,
          message: notes.trim() || undefined,
          ownerAccount: ownerAccount.trim() || undefined,
        });
        setPrepared(res);
        setScan(res.scan);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async (dryRun: boolean) => {
    if (!selected || !prepared) return;
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      const targetRef = prepared.mode === "use_only" ? prepared.tag : prepared.branch;
      const approval = {
        digest: prepared.scan.targetDigest,
        remote: prepared.repo,
        targetRef,
        acknowledgedWarnings,
        distributionDigest: prepared.mode === "use_only" ? prepared.distribution.commit : undefined,
      };
      if (prepared.mode === "use_only") {
        const result = await publishPackage(client, {
          sourceId: selected.sourceId,
          preparedId: prepared.preparedId,
          dryRun,
          confirmRemote: confirmRemote.trim(),
          approval,
        });
        setPublished(result);
      } else {
        const result = await publishSource(client, {
          sourceId: selected.sourceId,
          preparedId: prepared.preparedId,
          dryRun,
          confirmRemote: confirmRemote.trim(),
          approval,
        });
        setPublished(result);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeScan = prepared?.scan ?? scan;
  const blockingFindings = activeScan?.findings.filter((f) => f.severity === "block") ?? [];
  const warningFindings = activeScan?.findings.filter((f) => f.severity === "warning") ?? [];
  const expectedRemote = prepared?.repo ?? "";
  const canPublish =
    Boolean(prepared) &&
    gh.connected &&
    blockingFindings.length === 0 &&
    (!activeScan?.requiresReview || acknowledgedWarnings) &&
    confirmRemote.trim().toLowerCase() === expectedRemote.toLowerCase();

  return (
    <main className="publisher-shell">
      <header className="publisher-header">
        <div>
          <h1>Publisher — แชร์ Surface ให้สังคม</h1>
          <p>เลือก Surface ที่ลงทะเบียนในเครื่อง ตรวจสอบ artifact/commit แล้วเผยแพร่ขึ้น GitHub</p>
        </div>
        <div className="row">
          {gh.connected ? (
            <>
              <span className="badge ok">GitHub: {gh.username}</span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void githubDisconnect(client).then(setGh)}
              >
                ตัดการเชื่อมต่อ
              </button>
            </>
          ) : (
            <span className="badge err">ยังไม่เชื่อมต่อ GitHub</span>
          )}
        </div>
      </header>

      <div className="layout-grid">
        <aside className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Surface ในเครื่องคุณ ({sources.length})</strong>
            <button type="button" className="btn" disabled={busy} onClick={() => void handlePickSource()}>
              เพิ่มโฟลเดอร์ซอร์ส
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void loadAll()}>
              รีเฟรช
            </button>
          </div>
          {sources.length === 0 ? (
            <p className="muted">ไม่พบ Surface ที่ลงทะเบียนไว้ใน Host</p>
          ) : (
            <div className="source-list">
              {sources.map((item) => (
                <button
                  key={item.sourceId}
                  type="button"
                  disabled={busy}
                  className={`source-item ${selected?.sourceId === item.sourceId ? "active" : ""}`}
                  onClick={() => {
                    setSelected(item);
                    setRepoInput(`ponpoko-${item.id}`);
                    resetReview();
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.id} · v{item.version} · {statusLabel(item.status)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="card">
          {!selected ? (
            <>
              <p className="muted">เลือก Surface จากรายการด้านซ้ายเพื่อเริ่มต้น</p>
              {error && <p role="alert" className="badge err">{error}</p>}
            </>
          ) : (
            <>
              <h2>{selected.name}</h2>
              <p className="muted">
                {selected.description || selected.id} · {statusLabel(selected.status)} · v{selected.revision.version}
              </p>

              <div style={{ margin: "14px 0" }}>
                {activeScan === null ? (
                  <span className="muted">กำลังตรวจสอบความปลอดภัยและข้อมูลส่วนตัว...</span>
                ) : activeScan.clean ? (
                  <span className="badge ok">
                    ✓ ปลอดภัย: ไม่พบรหัสผ่านหรือข้อมูลส่วนตัว ({activeScan.scannedFiles} ไฟล์)
                  </span>
                ) : (
                  <div>
                    {blockingFindings.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <span className="badge err">
                          บล็อกการเผยแพร่ ({blockingFindings.length} รายการ)
                        </span>
                        <ul>
                          {blockingFindings.map((f) => (
                            <li key={`${f.path}:${f.ruleId}`} className="muted">
                              <code>{f.path}</code> [{f.ruleId}] — {f.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {warningFindings.length > 0 && (
                      <div>
                        <span className="badge" style={{ borderColor: "#d97706", color: "#d97706" }}>
                          คำเตือนที่ต้องตรวจสอบ ({warningFindings.length} รายการ)
                        </span>
                        <ul>
                          {warningFindings.map((f) => (
                            <li key={`${f.path}:${f.ruleId}`} className="muted">
                              <code>{f.path}</code> [{f.ruleId}] — {f.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="mode-group">
                <label className={`mode-option ${mode === "use_only" ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="share-mode"
                    checked={mode === "use_only"}
                    onChange={() => {
                      setMode("use_only");
                      resetReview();
                    }}
                  />
                  <div>
                    <strong>แบ่งให้ใช้งานอย่างเดียว (Use-only · Auto-update)</strong>
                    <div className="muted">
                      สร้างไฟล์ .surface บน GitHub Release ผู้รับติดตั้งแล้วรอรับอัปเดตจากคุณอัตโนมัติ
                    </div>
                  </div>
                </label>

                <label className={`mode-option ${mode === "open_source" ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="share-mode"
                    checked={mode === "open_source"}
                    onChange={() => {
                      setMode("open_source");
                      resetReview();
                    }}
                  />
                  <div>
                    <strong>แบ่งปัน Source Code (Open Source · ต่อยอดได้)</strong>
                    <div className="muted">
                      Push โค้ดที่ปลอดภัยขึ้น GitHub Repository เพื่อให้คนอื่นนำไปปรับแต่งต่อได้
                    </div>
                  </div>
                </label>
              </div>

              {!gh.connected && (
                <div className="field">
                  <label htmlFor="gh-token">GitHub Personal Access Token (สำหรับเชื่อมต่อบัญชี GitHub)</label>
                  <div className="row">
                    <input
                      id="gh-token"
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="ghp_... หรือ github_pat_..."
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="btn" disabled={busy} onClick={() => void handleConnect()}>
                      เชื่อมต่อ
                    </button>
                  </div>
                </div>
              )}

              <div className="field">
                <label htmlFor="repo-name">ชื่อ GitHub Repository</label>
                <input
                  id="repo-name"
                  value={repoInput}
                  onChange={(e) => {
                    setRepoInput(e.target.value);
                    resetReview();
                  }}
                  placeholder="ponpoko-my-surface"
                />
              </div>

              <div className="field">
                <label htmlFor="owner-account">Ponpoko Cloud Account ID (สำหรับ PONPOKO.md, ไม่บังคับ)</label>
                <input
                  id="owner-account"
                  value={ownerAccount}
                  onChange={(e) => {
                    setOwnerAccount(e.target.value);
                    resetReview();
                  }}
                  placeholder="acct_..."
                />
              </div>

              <div className="field">
                <label htmlFor="notes">คำอธิบาย / Release notes (ไม่บังคับ)</label>
                <textarea
                  id="notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    resetReview();
                  }}
                  placeholder="สิ่งที่อัปเดตหรือคำแนะนำสำหรับผู้ใช้..."
                />
              </div>

              <div className="row" style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || blockingFindings.length > 0}
                  onClick={() => void handlePrepare()}
                >
                  เตรียมและตรวจสอบชุดที่จะส่งจริง (Preview)
                </button>
              </div>

              {prepared && (
                <div className="card" style={{ marginBottom: 14 }}>
                  <strong>สรุปชุดที่จะเผยแพร่</strong>
                  <p className="muted">
                    ปลายทาง: <code>{prepared.repo}</code> ·{" "}
                    {prepared.mode === "use_only" ? `Tag: ${prepared.tag}` : `Branch: ${prepared.branch}`} ·{" "}
                    Digest: <code>{prepared.scan.targetDigest.slice(0, 12)}</code> · จำนวนไฟล์:{" "}
                    {prepared.filesCount}
                  </p>
                  {prepared.mode === "use_only" && (
                    <p className="muted">
                      Distribution branch <code>{prepared.distribution.branch}</code> · Commit{" "}
                      <code>{prepared.distribution.commit.slice(0, 12)}</code> · Immutable release
                    </p>
                  )}
                  <details>
                    <summary>ไฟล์ที่จะเปลี่ยนใน Git</summary>
                    <ul>{(prepared.mode === "use_only" ? prepared.distribution.files : prepared.preview.files).map(file => (
                      <li key={file.path}><code>{file.status} {file.path}</code></li>
                    ))}</ul>
                  </details>

                  {warningFindings.length > 0 && (
                    <label className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={acknowledgedWarnings}
                        onChange={(e) => setAcknowledgedWarnings(e.target.checked)}
                      />
                      <span className="muted">
                        ฉันตรวจสอบคำเตือนในรายการข้างต้นแล้ว ยืนยันว่าเป็นข้อมูลตัวอย่าง/ค่าตั้งค่าไม่ใช่รหัสผ่านจริง
                      </span>
                    </label>
                  )}

                  <div className="field" style={{ marginTop: 10 }}>
                    <label htmlFor="confirm-remote">
                      พิมพ์ชื่อปลายทาง <code>{prepared.repo}</code> เพื่อยืนยันการเผยแพร่
                    </label>
                    <input
                      id="confirm-remote"
                      value={confirmRemote}
                      onChange={(e) => setConfirmRemote(e.target.value)}
                      placeholder={prepared.repo}
                    />
                  </div>
                </div>
              )}

              {error && (
                <p className="badge err" style={{ display: "block", borderRadius: 10 }}>
                  {error}
                </p>
              )}

              <div className="row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !prepared || blockingFindings.length > 0}
                  onClick={() => void handlePublish(true)}
                >
                  ตรวจสอบแพ็กเกจ (Dry Run)
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !canPublish}
                  onClick={() => void handlePublish(false)}
                >
                  เผยแพร่ทันที (Publish)
                </button>
              </div>

              {published && (
                <div className="card" style={{ marginTop: 16 }}>
                  <span className="badge ok">
                    {published.dryRun ? "ทดสอบแพ็กเกจสำเร็จ (Dry Run)" : "เผยแพร่สำเร็จ!"}
                  </span>
                  <p className="muted" style={{ marginTop: 8 }}>
                    Repo: <code>{published.repo}</code> · จำนวนไฟล์: {published.filesCount}
                  </p>
                  <p className="muted">
                    ลิงก์:{" "}
                    <button
                      type="button"
                      className="btn"
                      style={{ minHeight: 28, padding: "0 10px", fontSize: 12 }}
                      onClick={() =>
                        void client.openExternal(
                          published.mode === "use_only" ? published.releaseUrl : published.repoUrl,
                        )
                      }
                    >
                      {published.mode === "use_only" ? published.releaseUrl : published.repoUrl}
                    </button>
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
