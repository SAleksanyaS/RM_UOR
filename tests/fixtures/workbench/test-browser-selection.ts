/** Test-only installed browser selection. An explicit path never falls back to another browser. */
export function testBrowserSelection(channel: 'msedge' | 'chrome' = 'msedge') {
  const executablePath = process.env.UOR_TEST_BROWSER_EXECUTABLE;
  return executablePath ? { executablePath, channel: undefined } : { channel };
}
