/**
 * dsh-to-go — Fluent UI Web Components v3 offline bundle entry.
 *
 * Purpose: register ONLY the <fluent-*> custom elements the configuration UI
 * uses, so esbuild tree-shakes the rest of @fluentui/web-components away.
 *
 * Pinned versions (see ../VERSION.txt):
 *   @fluentui/web-components 3.1.3
 *   @microsoft/fast-element  3.1.2
 *
 * Registration API note: v3.1.3 has NO `provideFluentDesignSystem().register()`
 * helper (that is the v2/FAST pattern). Each component exports a class plus a
 * `XxxDefinition` object, and registration is `Xxx.define(XxxDefinition)`.
 * Do not "fix" this back to provideFluentDesignSystem() — it does not exist here.
 *
 * Theme note: this bundle does NOT ship colors. Component styles read CSS custom
 * properties (--colorNeutralBackground1, --colorBrandBackground, ...) from the
 * Fluent 2 dark theme in ../fluent-theme.css. Loading that stylesheet alongside
 * this script is what makes the components dark.
 */

import {
  // design system + theming helper
  FluentDesignSystem,
  setTheme,

  // form / input
  Button,
  ButtonDefinition,
  ToggleButton,
  ToggleButtonDefinition,
  TextInput,
  TextInputDefinition,
  TextArea,
  TextAreaDefinition,
  Dropdown,
  DropdownDefinition,
  DropdownOption,
  DropdownOptionDefinition,
  Checkbox,
  CheckboxDefinition,
  Switch,
  SwitchDefinition,
  Field,
  FieldDefinition,
  Label,
  LabelDefinition,

  // navigation / containers
  Tablist,
  TablistDefinition,
  Tab,
  TabDefinition,
  Accordion,
  AccordionDefinition,
  AccordionItem,
  AccordionItemDefinition,
  Dialog,
  DialogDefinition,
  DialogBody,
  DialogBodyDefinition,

  // feedback
  ProgressBar,
  ProgressBarDefinition,
  Spinner,
  SpinnerDefinition,
  Badge,
  BadgeDefinition,
  Tooltip,
  TooltipDefinition,
  MessageBar,
  MessageBarDefinition,
  Divider,
  DividerDefinition,
} from '@fluentui/web-components';

const definitions = [
  [Button, ButtonDefinition],
  [ToggleButton, ToggleButtonDefinition],
  [TextInput, TextInputDefinition],
  [TextArea, TextAreaDefinition],
  [Dropdown, DropdownDefinition],
  [DropdownOption, DropdownOptionDefinition],
  [Checkbox, CheckboxDefinition],
  [Switch, SwitchDefinition],
  [Field, FieldDefinition],
  [Label, LabelDefinition],
  [Tablist, TablistDefinition],
  [Tab, TabDefinition],
  [Accordion, AccordionDefinition],
  [AccordionItem, AccordionItemDefinition],
  [Dialog, DialogDefinition],
  [DialogBody, DialogBodyDefinition],
  [ProgressBar, ProgressBarDefinition],
  [Spinner, SpinnerDefinition],
  [Badge, BadgeDefinition],
  [Tooltip, TooltipDefinition],
  [MessageBar, MessageBarDefinition],
  [Divider, DividerDefinition],
];

for (const [ctor, definition] of definitions) {
  ctor.define(definition);
}

/**
 * Literal tag manifest. Kept as plain strings (not computed from the
 * definitions) so the shipped file can be grepped/inspected offline to answer
 * "which tags does this bundle register?" without executing it.
 */
const tags = [
  'fluent-accordion',
  'fluent-accordion-item',
  'fluent-badge',
  'fluent-button',
  'fluent-checkbox',
  'fluent-dialog',
  'fluent-dialog-body',
  'fluent-divider',
  'fluent-dropdown',
  'fluent-field',
  'fluent-label',
  'fluent-message-bar',
  'fluent-option',
  'fluent-progress-bar',
  'fluent-spinner',
  'fluent-switch',
  'fluent-tab',
  'fluent-tablist',
  'fluent-textarea',
  'fluent-text-input',
  'fluent-toggle-button',
  'fluent-tooltip',
];

/**
 * Small surface for the page: theme scoping helper, tag manifest, and a cheap
 * readiness probe (`FluentUI.pending()` returns tags that failed to register).
 */
globalThis.FluentUI = {
  tags,
  setTheme,
  designSystem: FluentDesignSystem,
  pending() {
    return tags.filter(tag => !customElements.get(tag));
  },
};
