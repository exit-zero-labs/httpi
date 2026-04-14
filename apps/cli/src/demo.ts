import {
  defaultDemoHost,
  defaultDemoPort,
  startDemoServer,
} from "@exit-zero-labs/runmark-execution";

export { defaultDemoHost, defaultDemoPort, startDemoServer };

export async function runDemoServerCommand(options: {
  host?: string | undefined;
  port?: number | undefined;
}): Promise<void> {
  const { server, baseUrl } = await startDemoServer(options);
  process.stdout.write(
    [
      `[runmark demo] listening on ${baseUrl}`,
      "[runmark demo] local secret for pause/resume examples: devPassword=swordfish",
      "[runmark demo] press Ctrl-C to stop",
      "",
    ].join("\n"),
  );

  await new Promise<void>((resolve, reject) => {
    server.on("close", resolve);
    server.on("error", reject);
  });
}
