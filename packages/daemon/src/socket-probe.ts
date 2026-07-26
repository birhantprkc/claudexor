import { connect } from "node:net";

/** Whether a daemon already accepts connections on this Unix socket. */
export function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}
