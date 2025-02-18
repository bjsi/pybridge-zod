import { ChildProcess, spawn } from "child_process";
import { isAbsolute, join } from "path";
import { Subject } from "rxjs";
import { PyBridgeConfig } from "./config";
import { z } from "zod";
import { findParentPath } from "./fsUtils";

interface RpcMessage {
  id: number;
  ready?: true;
  result?: any;
  yield?: any;
  error?: string;
}

function fromCode(code: string): string {
  return `
import sys
import types

module = types.ModuleType('my_module')
my_code = ${JSON.stringify(code)}
exec(my_code, module.__dict__)
`;
}

const hook: string = `
import sys
import traceback
import json
from typing import Generator

def debug(*args):
    print(*args, file=sys.stderr, flush=True)

# redirect all output to stderr
orig_stdout = sys.stdout
sys.stdout = sys.stderr

{{__load__}}

try:
    for line in sys.stdin:
        p = None
        try:
            # debug("got: ", line)
            p = json.loads(line)
            result = getattr(module, p['method'])(*p['args'])
            # if result is a generator, iterate over it
            if isinstance(result, Generator):
                for r in result:
                    message = {'id': p['id'], 'yield': r}
                    print(json.dumps(message) + '\\n', file=orig_stdout, flush=True)
                print(json.dumps({'id': p['id']}) + '\\n', file=orig_stdout, flush=True)
            else:
                print(json.dumps({'id': p['id'], 'yield': result}) + '\\n', file=orig_stdout, flush=True)
                print(json.dumps({'id': p['id']}) + '\\n', file=orig_stdout, flush=True)
        except Exception as e:
            if p is not None:
                message = {'id': p['id'], 'error': traceback.format_exception(*sys.exc_info())}
                print(json.dumps(message) + '\\n', file=orig_stdout, flush=True)
            print("Failed nlp method\\n", file=sys.stderr, flush=True)
            traceback.print_exception(*sys.exc_info(), file=sys.stderr)
except KeyboardInterrupt:
    sys.exit(0)
`;

export class Controller {
  process: ChildProcess;
  messageId: number = 0;
  subscribers: { [messageId: number]: (data: RpcMessage) => void } = {};

  constructor(
    moduleNameOrCode: string,
    config: PyBridgeConfig,
    logger: (message: string) => void
  ) {
    let python = config.python;

    if (!isAbsolute(python)) {
      const venvBin = findParentPath("venv/bin");
      if (venvBin) {
        python = join(venvBin, python);
      }
    }

    let cwd = config.cwd;

    logger(
      `Start python via ${python} in ${cwd} for ${moduleNameOrCode
        .replace(/\n/g, "\\n")
        .substring(0, 50)}`
    );

    let load = moduleNameOrCode.includes(" ")
      ? fromCode(moduleNameOrCode)
      : `import ${moduleNameOrCode} as module;`;
    if (moduleNameOrCode.endsWith(".py")) {
      load = `import sys; sys.path.append('${cwd}'); import ${moduleNameOrCode.replace(
        ".py",
        ""
      )} as module;`;
    }

    const code = hook.replace("{{__load__}}", load);
    // console.log(code);
    this.process = spawn(python, ["-c", code], {
      stdio: ["pipe", "pipe", process.stderr],
      cwd: cwd,
    });

    process.on("exit", () => {
      this.process.kill();
    });

    const buffer: Buffer[] = [];
    const read = (data: Buffer) => {
      buffer.push(data);
      // console.log('read', data.includes('\n'), Buffer.concat(buffer).toString('utf8'));
      if (data.includes("\n".charCodeAt(0))) {
        const messages = Buffer.concat(buffer)
          .toString("utf8")
          .trim()
          .split("\n");
        for (const message of messages) {
          if (!message.startsWith('{"')) continue;
          try {
            const res = JSON.parse(message);
            const messageId = res.id;
            if (this.subscribers[messageId]) {
              this.subscribers[messageId](res);
            }
          } catch (error) {
            console.warn("Could not parse: " + message);
          }
        }
        buffer.length = 0;
      }
    };

    this.process.stdout!.on("data", read);
  }

  send<T>(method: string, args: any[], schema: z.ZodSchema<any>): Subject<T> {
    const messageId = this.messageId++;

    const subject = new Subject<any>();

    this.subscribers[messageId] = (data) => {
      try {
        if (data.ready) {
        } else if (data.yield) {
          const v = schema.parse(data.yield);
          subject.next(v);
        } else if (data.error) {
          delete this.subscribers[messageId];
          subject.error(new Error(data.error));
        } else {
          delete this.subscribers[messageId];
          subject.complete();
        }
      } catch {}
    };
    this.process.stdin!.write(
      JSON.stringify({ id: messageId, method, args }) + "\n"
    );

    return subject;
  }
}

type PromisifyFn<T extends (...args: any[]) => any> = (
  ...args: Parameters<T>
) => ReturnType<T> extends Subject<infer R>
  ? ReturnType<T>
  : ReturnType<T> extends Promise<any>
  ? ReturnType<T>
  : Promise<ReturnType<T>>;
export type RemoteController<T> = {
  [P in keyof T]: T[P] extends (...args: any[]) => any
    ? PromisifyFn<T[P]>
    : never;
};

export class PyBridge {
  protected controllers: { [name: string]: any } = {};

  constructor(
    protected config: PyBridgeConfig,
    protected logger: (message: string) => void = console.log
  ) {}

  close() {
    for (const controller of Object.values(this.controllers)) {
      controller.process.kill();
    }
  }

  controller<
    T extends z.ZodObject<{ [name: string]: z.ZodFunction<any, any> }>
  >(moduleName: string, schema: T): RemoteController<z.infer<T>> {
    if (this.controllers[moduleName]) return this.controllers[moduleName];
    const controller = new Controller(moduleName, this.config, this.logger);
    return (this.controllers[moduleName] = new Proxy(
      {},
      {
        get: (target, name: string) => {
          if (name === "process") return controller.process;

          return (...args: any[]) => {
            const returnType = schema.shape[name].returnType();
            const subject = controller.send(name, args, returnType);
            return subject.toPromise();
          };
        },
      }
    ) as any);
  }
}
