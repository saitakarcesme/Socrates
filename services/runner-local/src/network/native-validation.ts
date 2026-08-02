import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import { getGlobalDispatcher } from "undici";

import {
  NodeLocalRunnerControlPlaneFetchError,
  NodeLocalRunnerControlPlaneFetchResource,
} from "./control-plane-fetch-resource";

const fixtureDirectory = new URL(
  "../../../../.github/fixtures/local-runner/",
  import.meta.url,
);

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(name, fixtureDirectory));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestInit(): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    signal: new AbortController().signal,
    headers: { "content-type": "application/json" },
    body: '{"version":"1"}',
  };
}

async function main(): Promise<void> {
  assert.equal(process.env.SOCRATES_TEST_NETWORK_NATIVE, "1");

  const trustedKey = await fixture("network-server.test-key.pem");
  const trustedCertificate = await fixture("network-server.pem");
  const untrustedKey = await fixture("network-untrusted-server.test-key.pem");
  const untrustedCertificate = await fixture("network-untrusted-server.pem");

  let proxyConnections = 0;
  const proxy = createHttpServer((_request, response) => {
    proxyConnections += 1;
    response.writeHead(502).end();
  });
  proxy.on("connect", (_request, socket) => {
    proxyConnections += 1;
    socket.destroy();
  });

  let redirectTargetConnections = 0;
  const redirectTarget = createHttpsServer(
    {
      key: trustedKey,
      cert: trustedCertificate,
      minVersion: "TLSv1.2",
    },
    (_request, response) => {
      redirectTargetConnections += 1;
      response.writeHead(204).end();
    },
  );

  const observedProtocols: string[] = [];
  let trustedRequests = 0;
  let redirectLocation = "";
  const trusted = createHttpsServer(
    {
      key: trustedKey,
      cert: trustedCertificate,
      minVersion: "TLSv1.2",
    },
    (request, response) => {
      trustedRequests += 1;
      observedProtocols.push(
        (request.socket as TLSSocket).getProtocol() ?? "unknown",
      );
      assert.equal(request.method, "POST");
      if (request.url === "/v1/runner/redirect") {
        response.writeHead(302, { location: redirectLocation }).end();
        return;
      }
      assert.equal(request.url, "/v1/runner/native-validation");
      response.writeHead(204).end();
    },
  );

  const untrusted = createHttpsServer(
    {
      key: untrustedKey,
      cert: untrustedCertificate,
      minVersion: "TLSv1.2",
    },
    (_request, response) => response.writeHead(204).end(),
  );

  const servers = [proxy, redirectTarget, trusted, untrusted];
  const resources: NodeLocalRunnerControlPlaneFetchResource[] = [];
  const globalDispatcher = getGlobalDispatcher();
  try {
    const proxyPort = await listen(proxy);
    const redirectPort = await listen(redirectTarget);
    const trustedPort = await listen(trusted);
    const untrustedPort = await listen(untrusted);
    redirectLocation = `https://127.0.0.1:${redirectPort}/v1/runner/redirected`;

    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.NO_PROXY = "";
    process.env.NODE_USE_ENV_PROXY = "1";

    const trustedOrigin = `https://127.0.0.1:${trustedPort}`;
    const trustedResource = new NodeLocalRunnerControlPlaneFetchResource({
      origin: trustedOrigin,
    });
    resources.push(trustedResource);

    const success = await trustedResource.fetch(
      new URL("/v1/runner/native-validation", trustedOrigin),
      requestInit(),
    );
    assert.equal(success.status, 204);

    const redirect = await trustedResource.fetch(
      new URL("/v1/runner/redirect", trustedOrigin),
      requestInit(),
    );
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), redirectLocation);

    const untrustedOrigin = `https://127.0.0.1:${untrustedPort}`;
    const untrustedResource = new NodeLocalRunnerControlPlaneFetchResource({
      origin: untrustedOrigin,
    });
    resources.push(untrustedResource);
    const untrustedFailure = await untrustedResource
      .fetch(
        new URL("/v1/runner/native-validation", untrustedOrigin),
        requestInit(),
      )
      .catch((error: unknown) => error);
    assert.ok(
      untrustedFailure instanceof NodeLocalRunnerControlPlaneFetchError,
    );
    assert.equal(untrustedFailure.code, "network_failed");
    assert.equal("cause" in untrustedFailure, false);

    assert.equal(getGlobalDispatcher(), globalDispatcher);
    assert.equal(trustedRequests, 2);
    assert.equal(redirectTargetConnections, 0);
    assert.equal(proxyConnections, 0);
    assert.ok(
      observedProtocols.every(
        (protocol) => protocol === "TLSv1.2" || protocol === "TLSv1.3",
      ),
    );

    process.stdout.write(
      `${JSON.stringify({
        schema: "socrates.runner-network-native-evidence.v1",
        directConnections: trustedRequests,
        proxyConnections,
        redirectTargetConnections,
        protocols: observedProtocols,
        untrustedPeer: "rejected",
        globalDispatcher: "preserved",
      })}\n`,
    );
  } finally {
    for (const resource of resources.reverse()) {
      await resource.close().catch(() => undefined);
    }
    for (const server of servers.reverse()) {
      if (server.listening) await closeServer(server);
    }
  }
}

await main();
