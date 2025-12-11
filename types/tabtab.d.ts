declare module 'tabtab' {
  interface TabtabEnv {
    complete: boolean;
    words: number;
    point: number;
    line: string;
    partial: string;
    last: string;
    lastPartial: string;
    prev: string;
  }

  interface InstallOptions {
    name: string;
    completer: string;
  }

  interface UninstallOptions {
    name: string;
  }

  function parseEnv(env: NodeJS.ProcessEnv): TabtabEnv;
  function log(completions: string[]): void;
  function install(options: InstallOptions): Promise<void>;
  function uninstall(options: UninstallOptions): Promise<void>;

  export { parseEnv, log, install, uninstall, TabtabEnv, InstallOptions, UninstallOptions };
  export default { parseEnv, log, install, uninstall };
}
