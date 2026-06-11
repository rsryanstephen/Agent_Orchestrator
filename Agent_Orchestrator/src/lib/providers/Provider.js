'use strict';

/**
 * Base provider interface. Concrete providers extend this class and override all methods.
 *
 * capabilities shape:
 *   planMode       – provider supports Claude Code plan-mode (two-pass gate)
 *   skillsRuntime  – provider can execute harness skills natively
 *   subAgents      – provider can spawn sub-agents via the harness
 *   autoResume     – provider supports automatic token-reset resume
 *   streamJson     – provider emits stream-json events during spawn()
 *   hooks          – provider honours settings.json hooks
 *   permissionMode – provider respects Claude Code permission modes
 */
class Provider {
  /** @returns {string} stable provider id */
  get id() { throw new Error('Not implemented: id'); }

  /**
   * Probe whether this provider's CLI is available and authenticated.
   * @returns {Promise<boolean>}
   */
  async probe() { throw new Error('Not implemented: probe()'); }

  /**
   * Spawn the provider with the given prompt payload.
   * @param {string} payload - full prompt string
   * @param {object} opts
   * @param {boolean} [opts.silent]
   * @param {string}  [opts.label]
   * @param {string}  [opts.role]
   * @returns {Promise<{text: string, model: string|null, usage: object|null, costUsd: number|null, fallbackNote: string|null, effortNote: string|null}>}
   */
  async spawn(payload, opts) { throw new Error('Not implemented: spawn()'); }

  /**
   * Human-readable login instructions shown when the registry cannot auth this provider.
   * @returns {string}
   */
  loginInstructions() { throw new Error('Not implemented: loginInstructions()'); }

  /**
   * Parse a raw stdout/stderr chunk into a normalised event object, or null to skip.
   * Normalised event types: assistant_text | tool_call | tool_result | usage | error | done
   * @param {string} chunk
   * @returns {object|null}
   */
  parseStream(chunk) { return null; }

  /**
   * Provider capability flags.
   * @returns {{planMode: boolean, skillsRuntime: boolean, subAgents: boolean, autoResume: boolean, streamJson: boolean, hooks: boolean, permissionMode: boolean}}
   */
  get capabilities() {
    return {
      planMode: false,
      skillsRuntime: false,
      subAgents: false,
      autoResume: false,
      streamJson: false,
      hooks: false,
      permissionMode: false,
    };
  }
}

module.exports = Provider;
