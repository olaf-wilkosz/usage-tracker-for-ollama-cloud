// Shared by the browser-driven test scripts: stop the browser they started and delete its
// temporary profile. The browser is asked to close itself first (CDP Browser.close) so that it
// takes its windows and entries out of the Windows shell (Alt+Tab, taskbar) properly; killing it
// is only the fallback. Killing a browser outright left stale Alt+Tab entries behind.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the browser on this debugging port to quit; resolves when it answered (or could not). */
async function closeGracefully(port) {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    await new Promise((resolve) => {
      socket.addEventListener('close', resolve);
      socket.addEventListener('message', resolve);
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      setTimeout(resolve, 4000);
    });
    socket.close();
  } catch {
    // already gone or not reachable: the fallback below takes over
  }
}

/** Processes started with this temporary profile (Edge hands over to a differently parented one). */
function profileProcesses(profile) {
  if (process.platform !== 'win32') return [];
  const dir = profile.replace(/'/g, "''");
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine -replace '^.*?(--type=\\S+).*$','$1')" }`
  ], { encoding: 'utf8' }).stdout ?? '';
  return out.split(/\r?\n/).filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), what: line.split(' ').slice(1).join(' ').slice(0, 60) }));
}

export async function stopBrowser(proc, profile, port) {
  await closeGracefully(port);
  // a clean quit takes a moment; only what is still running after that is stopped by force
  for (let i = 0; i < 10 && profileProcesses(profile).length > 0; i++) await sleep(500);
  const leftover = profileProcesses(profile);
  if (leftover.length > 0) {
    console.warn(`The browser did not quit by itself; stopping by force: ${leftover.map((p) => `${p.pid} (${p.what})`).join(', ')}`);
    for (const { pid } of leftover) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { stdio: 'ignore' });
  }
  proc.kill();
  // the browser needs a moment to let go of its files; cleaning up must never fail the run
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      // still locked: try again
    }
  }
  console.warn(`Could not delete the temporary profile ${profile}; remove it by hand.`);
}
