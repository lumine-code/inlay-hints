const InlayHintsManager = require("./inlay-hints-manager");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "inlay-hints",
      tips: [
        "{% if keys['inlay-hints:toggle'] %}You can show or hide the inferred-type and parameter-name labels with {{ 'inlay-hints:toggle' | keystroke }}{% else %}Inlay hints show inferred types and parameter names as small labels inside your code, and can be switched off per language in the settings.{% endif %}",
      ],
    };
  },

  activate() {
    this.manager = new InlayHintsManager();
  },

  deactivate() {
    this.manager?.dispose();
    this.manager = null;
  },

  consumeInlayHints(provider) {
    return this.manager.registry.addProvider(provider);
  },
};
