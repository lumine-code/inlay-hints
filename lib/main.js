const InlayHintsManager = require("./inlay-hints-manager");

module.exports = {
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
