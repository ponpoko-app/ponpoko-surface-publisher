import { useCallback, useEffect, useState } from "react";
import {
  githubConnect,
  githubDisconnect,
  githubStatus,
  listSources,
  publishPackage,
  publishSource,
  scanSecurity,
  type PublisherClient,
} from "./client";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PublishPackageResult,
  PublishSourceResult,
  SecurityScanResult,
} from "../shared/types";

type ShareMode = "use_only" | "open_source";

export function App({ client }: { client: PublisherClient }) {
  const [sources, setSources] = useState<LocalSurfaceSource[]>([]);
  const [selected, setSelected] = useState<LocalSurfaceSource | null>(null);
  const [scan, setScan] = useState<SecurityScanResult | null>(null);
  const [gh, setGh] = useState<GitHubStatus>({ connected: false, username: null, source: "none" });
  const [tokenInput, setTokenInput] = useState("");
  const [mode, setMode] = useState<ShareMode>("use_only");
  const [repoInput, setRepoInput] = useState("");
  const [notes, setNotes] = useState("");
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

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [foundSources, status] = await Promise.all([listSources(client), githubStatus(client)]);
      setSources(foundSources);
      setGh(status);
      if (foundSources.length > 0 && !selected) {
        setSelected(foundSources[0]);
        setRepoInput(`ponpoko-${foundSources[0].id}`);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [client, selected]);

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
    void scanSecurity(client, selected.path)
      .then((result) => {
        if (!cancelled) setScan(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, selected]);

  const handleConnect = async () => {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await githubConnect(client, tokenInput);
      setGh(next);
      setTokenInput("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async (dryRun: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      if (mode === "use_only") {
        const result = await publishPackage(client, {
          path: selected.path,
          repo: repoInput.trim() || undefined,
          notes: notes.trim() || undefined,
          dryRun,
        });
        setPublished(result);
      } else {
        const result = await publishSource(client, {
          path: selected.path,
          repo: repoInput.trim() || undefined,
          message: notes.trim() || undefined,
          dryRun,
        });
        setPublished(result);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="publisher-shell">
      <header className="publisher-header">
        <div>
          <h1>Publisher — แชร์ Surface ให้สังคม</h1>
          <p>เลือก Surface ที่มี Source code ในเครื่อง ตรวจสอบความปลอดภัย แล้วเผยแพร่ขึ้น GitHub</p>
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
            <button type="button" className="btn" onClick={() => void loadAll()}>
              รีเฟรช
            </button>
          </div>
          {sources.length === 0 ? (
            <p className="muted">ไม่พบ Surface ที่มี Source code ใน ~/ponpoko-surfaces</p>
          ) : (
            <div className="source-list">
              {sources.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className={`source-item ${selected?.path === item.path ? "active" : ""}`}
                  onClick={() => {
                    setSelected(item);
                    setRepoInput(`ponpoko-${item.id}`);
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>{item.id} · v{item.version}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="card">
          {!selected ? (
            <p className="muted">เลือก Surface จากรายการด้านซ้ายเพื่อเริ่มต้น</p>
          ) : (
            <>
              <h2>{selected.name}</h2>
              <p className="muted">{selected.description || selected.path}</p>

              <div style={{ margin: "14px 0" }}>
                {scan === null ? (
                  <span className="muted">กำลังตรวจสอบความปลอดภัยและข้อมูลส่วนตัว...</span>
                ) : scan.clean ? (
                  <span className="badge ok">
                    ✓ ปลอดภัย: ไม่พบรหัสผ่านหรือข้อมูลส่วนตัว ({scan.scannedFiles} ไฟล์)
                  </span>
                ) : (
                  <div>
                    <span className="badge err">
                      พบไฟล์หรือรหัสผ่านที่อาจรั่วไหล ({scan.findings.length} รายการ)
                    </span>
                    <ul>
                      {scan.findings.map((f) => (
                        <li key={`${f.path}:${f.reason}`} className="muted">
                          <code>{f.path}</code> — {f.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="mode-group">
                <label className={`mode-option ${mode === "use_only" ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="share-mode"
                    checked={mode === "use_only"}
                    onChange={() => setMode("use_only")}
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
                    onChange={() => setMode("open_source")}
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
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="ponpoko-my-surface"
                />
              </div>

              <div className="field">
                <label htmlFor="notes">คำอธิบาย / Release notes (ไม่บังคับ)</label>
                <textarea
                  id="notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="สิ่งที่อัปเดตหรือคำแนะนำสำหรับผู้ใช้..."
                />
              </div>

              {error && (
                <p className="badge err" style={{ display: "block", borderRadius: 10 }}>
                  {error}
                </p>
              )}

              <div className="row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !scan?.clean}
                  onClick={() => void handlePublish(true)}
                >
                  ตรวจสอบแพ็กเกจ (Dry Run)
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !scan?.clean || !gh.connected}
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
