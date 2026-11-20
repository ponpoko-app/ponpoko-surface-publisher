import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { connect } from "./client";

async function main(): Promise<void> {
  const node = document.getElementById("app");
  if (!node) throw new Error("Publisher surface has no #app element");
  const root = createRoot(node);
  try {
    const client = await connect();
    addEventListener("pagehide", () => client.dispose(), { once: true });
    root.render(<App client={client} />);
  } catch (error) {
    root.render(
      <main className="publisher-shell">
        <h1>เปิด Publisher จากใน Ponpoko</h1>
        <p>{String(error)}</p>
      </main>,
    );
  }
}

void main();
