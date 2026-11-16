import * as clack from "@clack/prompts";
import { PromptCancelled, type Prompter } from "./init-wizard";

/** The wizard's questions, asked with @clack/prompts on stderr so stdout stays clean. */
export function clackPrompter(signal: AbortSignal): Prompter {
  const common = { output: process.stderr, input: process.stdin, signal };

  /** clack hands back a symbol when the person cancels; the wizard sees an exception instead. */
  const answer = <T>(value: T | typeof clack.CANCEL_SYMBOL): T => {
    if (clack.isCancel(value) || signal.aborted) throw new PromptCancelled();

    return value;
  };

  return {
    intro: (title) => clack.intro(title, common),
    outro: (message) => clack.outro(message, common),
    cancel: (message) => clack.cancel(message, common),
    note: (message, title) => clack.note(message, title, common),
    info: (message) => clack.log.info(message, common),
    step: (message) => clack.log.step(message, common),
    success: (message) => clack.log.success(message, common),
    warn: (message) => clack.log.warn(message, common),
    error: (message) => clack.log.error(message, common),

    async select(options) {
      return answer(
        await clack.select({
          ...common,
          message: options.message,
          options: options.options,
          initialValue: options.initial,
        }),
      );
    },

    async multiselect(options) {
      return answer(
        await clack.multiselect({
          ...common,
          message: options.message,
          options: options.options,
          initialValues: options.initial,
          required: true,
        }),
      );
    },

    async confirm(options) {
      return answer(
        await clack.confirm({ ...common, message: options.message, initialValue: options.initial }),
      );
    },

    async text(options) {
      return answer(
        await clack.text({
          ...common,
          message: options.message,
          placeholder: options.placeholder,
          initialValue: options.initial,
          validate: (value) => options.validate?.(value ?? ""),
        }),
      );
    },

    async password(options) {
      return answer(
        await clack.password({
          ...common,
          message: options.message,
          validate: (value) => options.validate?.(value ?? ""),
        }),
      );
    },

    async spin(message, work, done) {
      const spinner = clack.spinner(common);
      spinner.start(message);

      try {
        const value = await work();
        spinner.stop(done(value));

        return value;
      } catch (cause) {
        spinner.error(message);
        throw cause;
      }
    },
  };
}
