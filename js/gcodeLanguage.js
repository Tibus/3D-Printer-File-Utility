// ============================================================================
// Monaco G-code language — Monarch tokenizer + completion provider
// Covers Marlin / Klipper / Bambu firmware extensions.
// ============================================================================

function registerGcodeLanguage(monaco) {
  if (registerGcodeLanguage._done) return;
  registerGcodeLanguage._done = true;

  monaco.languages.register({ id: 'gcode', extensions: ['.gcode', '.nc'] });

  monaco.languages.setLanguageConfiguration('gcode', {
    comments: { lineComment: ';' },
    brackets: [['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider('gcode', {
    defaultToken: '',
    tokenPostfix: '.gcode',
    ignoreCase: true,
    tokenizer: {
      root: [
        // Line comments: ;...
        [/;.*$/, 'comment'],
        // Parenthesised inline comments: (...)
        [/\(.*?\)/, 'comment'],
        // G / M / T commands at start of token
        [/\b[GM]\d+(\.\d+)?\b/, 'keyword'],
        [/\bT\d+\b/, 'type'],
        // Parameters: letter + number (X10, Y-3.5, F6000, E0.04)
        [/\b[A-DF-LN-SUVWXYZ]-?\d+(\.\d+)?\b/, 'variable.parameter'],
        // Pure numbers
        [/-?\d+(\.\d+)?/, 'number'],
        // Strings
        [/"([^"\\]|\\.)*"/, 'string'],
      ],
    },
  });

  // Dark theme tuned to match the rest of the site (var --bg-secondary)
  monaco.editor.defineTheme('gcode-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '606070', fontStyle: 'italic' },
      { token: 'keyword', foreground: '818cf8', fontStyle: 'bold' },
      { token: 'type', foreground: 'f59e0b', fontStyle: 'bold' },
      { token: 'variable.parameter', foreground: '22c55e' },
      { token: 'number', foreground: 'f0f0f5' },
      { token: 'string', foreground: 'fab387' },
    ],
    colors: {
      'editor.background': '#12121a',
      'editor.foreground': '#f0f0f5',
      'editorLineNumber.foreground': '#606070',
      'editorLineNumber.activeForeground': '#a0a0b0',
      'editor.lineHighlightBackground': '#1c1c28',
      'editorCursor.foreground': '#818cf8',
      'editor.selectionBackground': '#6366f155',
      'editor.inactiveSelectionBackground': '#6366f122',
      'editorIndentGuide.background': '#22222e',
      'scrollbarSlider.background': '#22222e',
      'scrollbarSlider.hoverBackground': '#2a2a3a',
    },
  });

  monaco.languages.registerCompletionItemProvider('gcode', {
    triggerCharacters: ['G', 'M', 'T', ' '],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = GCODE_COMMANDS.map(cmd => ({
        label: cmd.label,
        kind: monaco.languages.CompletionItemKind.Function,
        detail: cmd.detail,
        documentation: { value: cmd.doc || cmd.detail },
        insertText: cmd.snippet || cmd.label,
        insertTextRules: cmd.snippet
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
        range,
      }));

      // Hover/param hints
      for (const p of GCODE_PARAMS) {
        suggestions.push({
          label: p.label,
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: p.detail,
          insertText: p.label,
          range,
        });
      }

      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider('gcode', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const w = word.word.toUpperCase();
      const cmd = GCODE_COMMANDS.find(c => c.label === w);
      if (cmd) {
        return {
          range: new monaco.Range(
            position.lineNumber, word.startColumn,
            position.lineNumber, word.endColumn
          ),
          contents: [
            { value: `**${cmd.label}** — ${cmd.detail}` },
            { value: cmd.doc || '' },
          ],
        };
      }
      return null;
    },
  });
}

// G-code command reference (Marlin / Klipper / Bambu extensions)
const GCODE_COMMANDS = [
  { label: 'G0', detail: 'Rapid linear move', snippet: 'G0 X${1:0} Y${2:0} F${3:6000}' },
  { label: 'G1', detail: 'Linear move (extrusion)', snippet: 'G1 X${1:0} Y${2:0} E${3:0} F${4:1800}' },
  { label: 'G2', detail: 'Clockwise arc move' },
  { label: 'G3', detail: 'Counter-clockwise arc move' },
  { label: 'G4', detail: 'Dwell (pause)', snippet: 'G4 S${1:1}' },
  { label: 'G10', detail: 'Retract' },
  { label: 'G11', detail: 'Unretract' },
  { label: 'G17', detail: 'Select XY plane' },
  { label: 'G18', detail: 'Select XZ plane' },
  { label: 'G19', detail: 'Select YZ plane' },
  { label: 'G20', detail: 'Set units to inches' },
  { label: 'G21', detail: 'Set units to millimetres' },
  { label: 'G28', detail: 'Auto-home', snippet: 'G28 ${1|X,Y,Z,X Y,X Y Z,|}' },
  { label: 'G29', detail: 'Bed levelling (auto)' },
  { label: 'G90', detail: 'Absolute positioning' },
  { label: 'G91', detail: 'Relative positioning' },
  { label: 'G92', detail: 'Set position', snippet: 'G92 E${1:0}' },
  { label: 'M0', detail: 'Unconditional stop (pause)' },
  { label: 'M1', detail: 'Conditional stop' },
  { label: 'M17', detail: 'Enable all steppers' },
  { label: 'M18', detail: 'Disable steppers (free movement)' },
  { label: 'M42', detail: 'Set pin state', doc: 'M42 P<pin> S<0-255> — control GPIO pin (e.g. pneumatic valve)', snippet: 'M42 P${1:0} S${2:255}' },
  { label: 'M73', detail: 'Set print progress %', snippet: 'M73 P${1:50} R${2:30}' },
  { label: 'M82', detail: 'Extruder absolute mode' },
  { label: 'M83', detail: 'Extruder relative mode' },
  { label: 'M84', detail: 'Disable steppers' },
  { label: 'M104', detail: 'Set hotend temperature (no wait)', snippet: 'M104 S${1:200}' },
  { label: 'M105', detail: 'Report temperatures' },
  { label: 'M106', detail: 'Fan on', doc: 'M106 [P<index>] [S<0-255>]', snippet: 'M106 P${1:1} S${2:255}' },
  { label: 'M107', detail: 'Fan off', snippet: 'M107 P${1:1}' },
  { label: 'M109', detail: 'Wait for hotend temperature', snippet: 'M109 S${1:200}' },
  { label: 'M140', detail: 'Set bed temperature (no wait)', snippet: 'M140 S${1:60}' },
  { label: 'M190', detail: 'Wait for bed temperature', snippet: 'M190 S${1:60}' },
  { label: 'M191', detail: 'Wait for chamber temperature', snippet: 'M191 S${1:35}' },
  { label: 'M201', detail: 'Set max acceleration (mm/s²)' },
  { label: 'M203', detail: 'Set max feedrate (mm/s)' },
  { label: 'M204', detail: 'Set default acceleration' },
  { label: 'M205', detail: 'Set advanced settings (jerk)' },
  { label: 'M220', detail: 'Set speed factor %', snippet: 'M220 S${1:100}' },
  { label: 'M221', detail: 'Set flow factor %', snippet: 'M221 S${1:100}' },
  { label: 'M302', detail: 'Allow/disallow cold extrusion' },
  { label: 'M400', detail: 'Wait for all moves to finish' },
  { label: 'M500', detail: 'Save settings to EEPROM' },
  { label: 'M600', detail: 'Filament change (pause + prompt)' },
  { label: 'M620', detail: 'Bambu — AMS load filament' },
  { label: 'M621', detail: 'Bambu — AMS unload filament' },
  { label: 'M622', detail: 'Bambu — AMS conditional' },
  { label: 'M628', detail: 'Bambu — Begin filament load', snippet: 'M628 S${1:1}' },
  { label: 'M629', detail: 'Bambu — End filament load', snippet: 'M629 S${1:1}' },
  { label: 'M710', detail: 'Bambu — Control board fan' },
  { label: 'M900', detail: 'Linear advance K-factor', snippet: 'M900 K${1:0.04}' },
  { label: 'M960', detail: 'Bambu — LED light control' },
  { label: 'M970', detail: 'Bambu — Calibration sequence' },
  { label: 'M972', detail: 'Bambu — Disable motor' },
  { label: 'M973', detail: 'Bambu — Print noise / motor melody' },
  { label: 'T0', detail: 'Select tool 0' },
  { label: 'T1', detail: 'Select tool 1' },
  { label: 'T2', detail: 'Select tool 2' },
  { label: 'T3', detail: 'Select tool 3' },
];

const GCODE_PARAMS = [
  { label: 'X', detail: 'X axis position (mm)' },
  { label: 'Y', detail: 'Y axis position (mm)' },
  { label: 'Z', detail: 'Z axis position (mm)' },
  { label: 'E', detail: 'Extruder amount (mm)' },
  { label: 'F', detail: 'Feedrate (mm/min)' },
  { label: 'S', detail: 'Setting / value (e.g. temperature, PWM)' },
  { label: 'P', detail: 'Parameter / pin / index' },
  { label: 'R', detail: 'Radius / remaining' },
  { label: 'I', detail: 'Arc centre offset X' },
  { label: 'J', detail: 'Arc centre offset Y' },
  { label: 'K', detail: 'Linear advance factor' },
];
