import { type Socket } from "node:net";
import { createInterface } from "node:readline";

/**
 * Lifecycle owner for local RPC follower sockets. A disconnected follower is
 * dropped instead of crashing the daemon: readline re-emits asynchronous
 * socket write failures (such as EPIPE) on its Interface, so the Interface
 * and the socket share one cleanup, and sends skip sockets that can no
 * longer receive.
 */
export class RpcFollowers {
  private readonly sockets = new Set<Socket>();

  attach(sock: Socket, onLine: (line: string) => void): void {
    this.sockets.add(sock);
    const rl = createInterface({ input: sock });
    const cleanup = () => {
      rl.close();
      this.drop(sock);
    };
    rl.on("line", onLine);
    rl.on("error", cleanup);
    sock.on("error", cleanup);
    sock.on("close", cleanup);
  }

  send(sock: Socket, obj: unknown): void {
    if (sock.destroyed || !sock.writable) {
      this.drop(sock);
      return;
    }
    try {
      sock.write(JSON.stringify(obj) + "\n");
    } catch {
      this.drop(sock);
    }
  }

  /** Destroy every follower so server.close() cannot hang on live sockets. */
  destroyAll(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  private drop(sock: Socket): void {
    this.sockets.delete(sock);
    if (!sock.destroyed) sock.destroy();
  }
}
