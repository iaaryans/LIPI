/* ============================================================
   LIPI ENGINE v3.0 — PRODUCTION-GRADE AST COMPILER
   Architecture: Lexer → Parser → AST → Code Generator → Runtime
   
   CHANGELOG from v10.0:
   ─────────────────────────────────────────────────────────────
   [FIX-CRITICAL] callExpr no longer blindly injects `await`.
     Only user-defined functions, `wait`, and `getInput` are awaited.
     This fixes broken output like `(await console.log(...))`.
   
   [FIX-CRITICAL] `on target.event` codegen now handles both
     __sel_ identifiers AND plain variable expressions correctly.
   
   [FIX-CRITICAL] `for key in obj` now correctly iterates object
     keys (Object.keys) and array indices/values appropriately.
   
   [FIX] `new Function(js)()` upgraded to properly surface async
     errors via .catch() so runtime errors always show in console.
   
   [FIX] style shortcut map: box.style.bg → backgroundColor,
     box.style.fg → color, box.style.size → fontSize, etc.
   
   [NEW] `print` builtin added (alias for log).
   
   [NEW] `++` and `--` postfix/prefix increment operators.
   
   [NEW] `**` exponentiation operator.
   
   [NEW] `delete obj.key` statement support.
   
   [NEW] `typeof expr` unary operator.
   
   [NEW] Ternary expression: `x if cond else y` (Python-style).
   
   [NEW] String interpolation via backtick syntax: `hello {name}`.
   
   [NEW] Additional builtins: len(), keys(), values(), str(), 
     bool(), abs(), max(), min(), round(), floor(), ceil(),
     type(), push(), pop(), append(), has(), random().
   
   [NEW] `assert cond` statement for debugging.
   
   [NEW] Compound assignment operators: //= (floor div), **=.
   
   [NEW] Named function calls are auto-detected as async when
     the function is declared async in the current scope — the
     compiler now tracks user-declared function names and awaits
     them correctly.
   
   [IMPROVED] Error messages include compiled JS snippet for
     debugging when a JS syntax error occurs.
   
   [IMPROVED] Runtime fully exposes Math, JSON, Object, Array,
     console, Date so user code can access them directly.
   ============================================================ */

(function () {
  "use strict";

  // ─────────────────────────────────────────────
  // 1.  TOKEN TYPES
  // ─────────────────────────────────────────────
  const TT = {
    Number:      "Number",
    String:      "String",
    TemplateLit: "TemplateLit", // backtick strings with {expr}
    Bool:        "Bool",
    Null:        "Null",
    Undefined:   "Undefined",
    Ident:       "Ident",
    Keyword:     "Keyword",
    LParen:      "LParen",
    RParen:      "RParen",
    LBrace:      "LBrace",
    RBrace:      "RBrace",
    LBracket:    "LBracket",
    RBracket:    "RBracket",
    Comma:       "Comma",
    Dot:         "Dot",
    Colon:       "Colon",
    Semicolon:   "Semicolon",
    Arrow:       "Arrow",     // ->
    // Operators
    Assign:      "Assign",    // =
    Plus:        "Plus",
    Minus:       "Minus",
    Star:        "Star",
    StarStar:    "StarStar",  // **
    Slash:       "Slash",
    SlashSlash:  "SlashSlash",// //  (floor division)
    Percent:     "Percent",
    Bang:        "Bang",
    EqEq:        "EqEq",
    BangEq:      "BangEq",
    Lt:          "Lt",
    LtEq:        "LtEq",
    Gt:          "Gt",
    GtEq:        "GtEq",
    AmpAmp:      "AmpAmp",
    PipePipe:    "PipePipe",
    PlusEq:      "PlusEq",
    MinusEq:     "MinusEq",
    StarEq:      "StarEq",
    SlashEq:     "SlashEq",
    PercentEq:   "PercentEq",
    SlashSlashEq:"SlashSlashEq",// //=
    PlusPlus:    "PlusPlus",   // ++
    MinusMinus:  "MinusMinus", // --
    Newline:     "Newline",
    EOF:         "EOF",
  };

  const KEYWORDS = new Set([
    "let", "if", "else", "for", "while", "func", "return",
    "on", "in", "and", "or", "not",
    "log", "print", "wait", "getInput",
    "true", "false", "null", "undefined",
    "delete", "typeof", "assert",
    "break", "continue",
  ]);

  // ─────────────────────────────────────────────
  // 2.  LEXER
  // ─────────────────────────────────────────────
  class LexError extends Error {
    constructor(msg, line) {
      super(`LexError (line ${line}): ${msg}`);
      this.line = line;
    }
  }

  class Lexer {
    constructor(src) {
      this.src    = src;
      this.pos    = 0;
      this.line   = 1;
      this.tokens = [];
    }

    ch(offset = 0)  { return this.src[this.pos + offset] ?? null; }
    advance()       { if (this.ch() === "\n") this.line++; this.pos++; }
    isAlpha(c)      { return c !== null && /[a-zA-Z_$]/.test(c); }
    isAlNum(c)      { return c !== null && /[a-zA-Z0-9_$]/.test(c); }
    isDigit(c)      { return c !== null && /[0-9]/.test(c); }
    tok(type, val, line) { return { type, val, line: line ?? this.line }; }

    tokenize() {
      while (this.pos < this.src.length) {
        this.readToken();
      }
      this.tokens.push(this.tok(TT.EOF, null));
      return this.tokens;
    }

    readToken() {
      const c = this.ch();

      // Whitespace (not newlines)
      if (c === " " || c === "\t" || c === "\r") { this.advance(); return; }

      // Newlines — collapse runs into one token
      if (c === "\n") {
        const ln = this.line;
        while (this.ch() === "\n") this.advance();
        this.tokens.push(this.tok(TT.Newline, "\n", ln));
        return;
      }

      // Line comments // — but NOT if this is the // floor-division operator.
      // We distinguish by checking if the preceding non-whitespace token
      // was a value-producing token (Number, Ident, RParen, RBracket).
      // Simpler heuristic: if the last real token is value-producing, treat as operator.
      if (c === "/" && this.ch(1) === "/") {
        const lastTok = this.tokens[this.tokens.length - 1];
        const isValueToken = lastTok && (
          lastTok.type === TT.Number   ||
          lastTok.type === TT.String   ||
          lastTok.type === TT.Bool     ||
          lastTok.type === TT.Null     ||
          lastTok.type === TT.Ident    ||
          lastTok.type === TT.RParen   ||
          lastTok.type === TT.RBracket
        );
        if (isValueToken) {
          // This is floor-division operator — let it fall through to multiMap
        } else {
          while (this.ch() !== null && this.ch() !== "\n") this.advance();
          return;
        }
      }

      // Hash comments (# followed by space/tab/newline/null)
      if (c === "#") {
        const next = this.ch(1);
        if (next === " " || next === "\t" || next === "\n" || next === null) {
          while (this.ch() !== null && this.ch() !== "\n") this.advance();
          return;
        }
        // DOM selector shorthand: #myId
        this.advance();
        const ln = this.line;
        let id = "";
        while (this.isAlNum(this.ch()) || this.ch() === "-") {
          id += this.ch(); this.advance();
        }
        if (!id) throw new LexError("Expected selector name after '#'", ln);
        this.tokens.push(this.tok(TT.Ident, `__sel_${id}`, ln));
        return;
      }

      // Numbers
      if (this.isDigit(c) || (c === "." && this.isDigit(this.ch(1)))) {
        this.readNumber(); return;
      }

      // Strings
      if (c === '"' || c === "'") { this.readString(c); return; }

      // Template literals (backtick)
      if (c === "`") { this.readTemplateLit(); return; }

      // Identifiers / keywords
      if (this.isAlpha(c)) { this.readIdent(); return; }

      // Multi-character operators — order matters: longer first
      const ln = this.line;
      const c2 = c + (this.ch(1) ?? "");
      const c3 = c2 + (this.ch(2) ?? "");

      // 3-char operators: **= and //=
      if (c3 === "**=") {
        this.advance(); this.advance(); this.advance();
        this.tokens.push(this.tok(TT.StarStarEq, "**=", ln)); return;
      }
      if (c3 === "//=") {
        this.advance(); this.advance(); this.advance();
        this.tokens.push(this.tok(TT.SlashSlashEq, "//=", ln)); return;
      }
      // 2-char
      const multiMap = {
        "==": TT.EqEq,    "!=": TT.BangEq, ">=": TT.GtEq,  "<=": TT.LtEq,
        "->": TT.Arrow,   "+=": TT.PlusEq, "-=": TT.MinusEq,
        "*=": TT.StarEq,  "/=": TT.SlashEq, "%=": TT.PercentEq,
        "&&": TT.AmpAmp,  "||": TT.PipePipe,
        "**": TT.StarStar, "//": TT.SlashSlash,
        "++": TT.PlusPlus, "--": TT.MinusMinus,
      };
      if (multiMap[c2]) {
        this.advance(); this.advance();
        this.tokens.push(this.tok(multiMap[c2], c2, ln)); return;
      }

      // Single-char
      const singleMap = {
        "(": TT.LParen,   ")": TT.RParen,
        "{": TT.LBrace,   "}": TT.RBrace,
        "[": TT.LBracket, "]": TT.RBracket,
        ",": TT.Comma,    ".": TT.Dot,    ":": TT.Colon,  ";": TT.Semicolon,
        "=": TT.Assign,   "+": TT.Plus,   "-": TT.Minus,
        "*": TT.Star,     "/": TT.Slash,  "%": TT.Percent,
        "!": TT.Bang,     "<": TT.Lt,     ">": TT.Gt,
      };
      if (singleMap[c]) {
        this.advance();
        this.tokens.push(this.tok(singleMap[c], c, ln)); return;
      }

      throw new LexError(`Unexpected character '${c}'`, this.line);
    }

    readNumber() {
      const ln = this.line;
      let val = "";
      while (this.isDigit(this.ch())) { val += this.ch(); this.advance(); }
      if (this.ch() === "." && this.isDigit(this.ch(1))) {
        val += "."; this.advance();
        while (this.isDigit(this.ch())) { val += this.ch(); this.advance(); }
      }
      // Scientific notation: 1e10, 2.5e-3
      if (this.ch() === "e" || this.ch() === "E") {
        val += this.ch(); this.advance();
        if (this.ch() === "+" || this.ch() === "-") { val += this.ch(); this.advance(); }
        while (this.isDigit(this.ch())) { val += this.ch(); this.advance(); }
      }
      this.tokens.push(this.tok(TT.Number, val, ln));
    }

    readString(quot) {
      const ln = this.line;
      this.advance(); // opening quote
      let val = "";
      while (this.ch() !== null && this.ch() !== quot) {
        if (this.ch() === "\\") {
          this.advance();
          const esc = this.ch(); this.advance();
          const escMap = { n:"\n", t:"\t", r:"\r", "\\":"\\", "'":"'", '"':'"', "0":"\0" };
          val += escMap[esc] ?? ("\\" + esc);
        } else {
          val += this.ch(); this.advance();
        }
      }
      if (this.ch() === null) throw new LexError("Unterminated string", ln);
      this.advance(); // closing quote
      this.tokens.push(this.tok(TT.String, val, ln));
    }

    // Template literals: `Hello {name}, you are {age} years old`
    // We lex the entire backtick string and store raw content.
    // The parser will handle interpolation.
    readTemplateLit() {
      const ln = this.line;
      this.advance(); // skip opening backtick
      let raw = "";
      while (this.ch() !== null && this.ch() !== "`") {
        if (this.ch() === "\\") {
          this.advance();
          const esc = this.ch(); this.advance();
          const escMap = { n:"\\n", t:"\\t", r:"\\r", "\\":"\\\\", "`":"`" };
          raw += escMap[esc] ?? ("\\" + esc);
        } else {
          // Escape backticks and backslashes for later JS template literal use
          if (this.ch() === "$") {
            raw += "\\$"; this.advance();
          } else {
            raw += this.ch(); this.advance();
          }
        }
      }
      if (this.ch() === null) throw new LexError("Unterminated template literal", ln);
      this.advance(); // closing backtick
      // Convert {expr} to ${expr} for JS template literals
      // We store the raw string and codegen will wrap it in backticks
      // Replace {identifier} and {expr} patterns — simple approach: store as-is,
      // but prefix { with $ for JS. We handle this in codegen.
      this.tokens.push(this.tok(TT.TemplateLit, raw, ln));
    }

    readIdent() {
      const ln = this.line;
      let val = "";
      while (this.isAlNum(this.ch())) { val += this.ch(); this.advance(); }
      if (val === "true" || val === "false") {
        this.tokens.push(this.tok(TT.Bool, val, ln)); return;
      }
      if (val === "null")      { this.tokens.push(this.tok(TT.Null,      val, ln)); return; }
      if (val === "undefined") { this.tokens.push(this.tok(TT.Undefined, val, ln)); return; }
      if (KEYWORDS.has(val))   { this.tokens.push(this.tok(TT.Keyword,   val, ln)); return; }
      this.tokens.push(this.tok(TT.Ident, val, ln));
    }
  }

  // ─────────────────────────────────────────────
  // 3.  AST NODE CONSTRUCTORS
  // ─────────────────────────────────────────────
  const Node = {
    Program:      (body)                     => ({ type:"Program", body }),
    VarDecl:      (name, init, ln)           => ({ type:"VarDecl", name, init, ln }),
    Assign:       (target, op, value, ln)    => ({ type:"Assign", target, op, value, ln }),
    IfStmt:       (branches, alt, ln)        => ({ type:"IfStmt", branches, alt, ln }),
    WhileStmt:    (test, body, ln)           => ({ type:"WhileStmt", test, body, ln }),
    ForInStmt:    (iter, iterable, body, ln) => ({ type:"ForInStmt", iter, iterable, body, ln }),
    FuncDecl:     (name, params, body, ln)   => ({ type:"FuncDecl", name, params, body, ln }),
    ReturnStmt:   (value, ln)                => ({ type:"ReturnStmt", value, ln }),
    OnEvent:      (target, event, body, ln)  => ({ type:"OnEvent", target, event, body, ln }),
    ExprStmt:     (expr, ln)                 => ({ type:"ExprStmt", expr, ln }),
    DeleteStmt:   (target, ln)               => ({ type:"DeleteStmt", target, ln }),
    AssertStmt:   (cond, msg, ln)            => ({ type:"AssertStmt", cond, msg, ln }),
    BreakStmt:    (ln)                       => ({ type:"BreakStmt", ln }),
    ContinueStmt: (ln)                       => ({ type:"ContinueStmt", ln }),
    Block:        (body)                     => ({ type:"Block", body }),

    // Expressions
    NumberLit:    (val, ln)                  => ({ type:"NumberLit", val, ln }),
    StringLit:    (val, ln)                  => ({ type:"StringLit", val, ln }),
    TemplateLit:  (raw, ln)                  => ({ type:"TemplateLit", raw, ln }),
    BoolLit:      (val, ln)                  => ({ type:"BoolLit", val, ln }),
    NullLit:      (ln)                       => ({ type:"NullLit", ln }),
    UndefinedLit: (ln)                       => ({ type:"UndefinedLit", ln }),
    ArrayLit:     (elements, ln)             => ({ type:"ArrayLit", elements, ln }),
    ObjectLit:    (props, ln)                => ({ type:"ObjectLit", props, ln }),
    Identifier:   (name, ln)                 => ({ type:"Identifier", name, ln }),
    Selector:     (id, ln)                   => ({ type:"Selector", id, ln }),
    BinaryExpr:   (op, left, right, ln)      => ({ type:"BinaryExpr", op, left, right, ln }),
    UnaryExpr:    (op, arg, ln)              => ({ type:"UnaryExpr", op, arg, ln }),
    PostfixExpr:  (op, arg, ln)              => ({ type:"PostfixExpr", op, arg, ln }),
    LogicalExpr:  (op, left, right, ln)      => ({ type:"LogicalExpr", op, left, right, ln }),
    TernaryExpr:  (cond, cons, alt, ln)      => ({ type:"TernaryExpr", cond, cons, alt, ln }),
    CallExpr:     (callee, args, ln)         => ({ type:"CallExpr", callee, args, ln }),
    MemberExpr:   (obj, prop, computed, ln)  => ({ type:"MemberExpr", obj, prop, computed, ln }),
  };

  // ─────────────────────────────────────────────
  // 4.  PARSER  (Recursive Descent + Pratt)
  // ─────────────────────────────────────────────
  class ParseError extends Error {
    constructor(msg, line) {
      super(`ParseError (line ${line}): ${msg}`);
      this.line = line;
    }
  }

  // Operator precedence (higher = tighter binding)
  const PREC = {
    [TT.PipePipe]:  1,
    [TT.AmpAmp]:    2,
    [TT.EqEq]:      3, [TT.BangEq]:   3,
    [TT.Lt]:        4, [TT.LtEq]:     4, [TT.Gt]: 4, [TT.GtEq]: 4,
    [TT.Plus]:      5, [TT.Minus]:    5,
    [TT.Star]:      6, [TT.Slash]:    6, [TT.Percent]: 6, [TT.SlashSlash]: 6,
    [TT.StarStar]:  7, // right-associative exponentiation
  };

  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos    = 0;
      // Track user-declared function names so codegen can await them
      this.asyncFunctions = new Set();
    }

    peek(offset = 0) { return this.tokens[this.pos + offset] ?? { type: TT.EOF, val: null, line: -1 }; }
    cur()            { return this.peek(0); }
    advance()        { const t = this.cur(); this.pos++; return t; }

    at(type, val) {
      const t = this.cur();
      if (t.type !== type) return false;
      if (val !== undefined && t.val !== val) return false;
      return true;
    }

    eat(type, val) {
      if (!this.at(type, val)) {
        const t = this.cur();
        const expected = val !== undefined ? `'${val}'` : type;
        throw new ParseError(
          `Expected ${expected} but got '${t.val ?? t.type}' (${t.type})`,
          t.line
        );
      }
      return this.advance();
    }

    skipNewlines() {
      while (this.at(TT.Newline)) this.advance();
    }

    // ── Top level ────────────────────────────
    parse() {
      const body = [];
      this.skipNewlines();
      while (!this.at(TT.EOF)) {
        body.push(this.parseStatement());
        while (this.at(TT.Newline) || this.at(TT.Semicolon)) this.advance();
      }
      return Node.Program(body);
    }

    // ── Statements ───────────────────────────
    parseStatement() {
      const t = this.cur();

      if (t.type === TT.Keyword) {
        switch (t.val) {
          case "let":      return this.parseVarDecl();
          case "if":       return this.parseIf();
          case "while":    return this.parseWhile();
          case "for":      return this.parseFor();
          case "func":     return this.parseFuncDecl();
          case "return":   return this.parseReturn();
          case "on":       return this.parseOn();
          case "delete":   return this.parseDelete();
          case "assert":   return this.parseAssert();
          case "break":    { this.advance(); return Node.BreakStmt(t.line); }
          case "continue": { this.advance(); return Node.ContinueStmt(t.line); }
        }
      }

      return this.parseExprOrAssignStmt();
    }

    parseVarDecl() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "let");
      const name = this.eat(TT.Ident).val;
      this.eat(TT.Assign);
      const init = this.parseExpression();
      return Node.VarDecl(name, init, ln);
    }

    parseIf() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "if");
      const cond = this.parseExpression(true);
      const body = this.parseBlock();
      const branches = [{ cond, body }];
      let alt = null;

      let loop = true;
      while (loop) {
        // peek past newlines to find 'else'
        let probe = this.pos;
        while (this.tokens[probe]?.type === TT.Newline) probe++;
        const next = this.tokens[probe];
        if (next?.type === TT.Keyword && next?.val === "else") {
          this.skipNewlines();
          this.eat(TT.Keyword, "else");
          if (this.at(TT.Keyword, "if")) {
            this.eat(TT.Keyword, "if");
            const c = this.parseExpression(true);
            const b = this.parseBlock();
            branches.push({ cond: c, body: b });
          } else {
            alt  = this.parseBlock();
            loop = false;
          }
        } else {
          loop = false;
        }
      }
      return Node.IfStmt(branches, alt, ln);
    }

    parseWhile() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "while");
      const test = this.parseExpression(true);
      const body = this.parseBlock();
      return Node.WhileStmt(test, body, ln);
    }

    parseFor() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "for");
      const iter = this.eat(TT.Ident).val;
      this.eat(TT.Keyword, "in");
      const iterable = this.parseExpression(true);
      const body     = this.parseBlock();
      return Node.ForInStmt(iter, iterable, body, ln);
    }

    parseFuncDecl() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "func");
      const name = this.eat(TT.Ident).val;
      // Register as async so call sites can await it
      this.asyncFunctions.add(name);
      const params = [];
      if (this.at(TT.LParen)) {
        this.eat(TT.LParen);
        while (!this.at(TT.RParen) && !this.at(TT.EOF)) {
          this.skipNewlines();
          if (this.at(TT.RParen)) break;
          params.push(this.eat(TT.Ident).val);
          this.skipNewlines();
          if (this.at(TT.Comma)) this.advance();
        }
        this.eat(TT.RParen);
      }
      const body = this.parseBlock();
      return Node.FuncDecl(name, params, body, ln);
    }

    parseReturn() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "return");
      let value = null;
      if (!this.at(TT.Newline) && !this.at(TT.Semicolon) && !this.at(TT.EOF) && !this.at(TT.RBrace)) {
        value = this.parseExpression();
      }
      return Node.ReturnStmt(value, ln);
    }

    parseOn() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "on");
      // on target.eventName { ... }
      // Parse potentially-dotted target path; last segment is the event name
      const parts = [this.eat(TT.Ident).val];
      while (this.at(TT.Dot)) {
        this.advance();
        parts.push(this.eat(TT.Ident).val);
      }
      if (parts.length < 2) {
        throw new ParseError("'on' requires 'target.eventName' syntax", ln);
      }
      const eventName = parts.pop();
      const targetStr = parts.join(".");
      const body = this.parseBlock();
      return Node.OnEvent(targetStr, eventName, body, ln);
    }

    parseDelete() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "delete");
      const target = this.parseExpression();
      return Node.DeleteStmt(target, ln);
    }

    parseAssert() {
      const ln = this.cur().line;
      this.eat(TT.Keyword, "assert");
      const cond = this.parseExpression(false);
      let msg = null;
      // optional: assert x, "message"
      if (this.at(TT.Comma)) {
        this.advance();
        msg = this.parseExpression();
      }
      return Node.AssertStmt(cond, msg, ln);
    }

    parseExprOrAssignStmt() {
      const ln   = this.cur().line;
      const expr = this.parseExpression();

      const assignOps = new Set([
        TT.Assign, TT.PlusEq, TT.MinusEq, TT.StarEq, TT.SlashEq,
        TT.PercentEq, TT.StarStarEq, TT.SlashSlashEq,
      ]);
      if (assignOps.has(this.cur().type)) {
        const op  = this.advance().val;
        const val = this.parseExpression();
        return Node.Assign(expr, op, val, ln);
      }

      return Node.ExprStmt(expr, ln);
    }

    parseBlock() {
      this.skipNewlines();
      this.eat(TT.LBrace);
      const body = [];
      while (!this.at(TT.RBrace) && !this.at(TT.EOF)) {
        this.skipNewlines();
        if (this.at(TT.RBrace)) break;
        body.push(this.parseStatement());
        while (this.at(TT.Newline) || this.at(TT.Semicolon)) this.advance();
      }
      this.eat(TT.RBrace);
      return Node.Block(body);
    }

    // ── Expression Parsing (Pratt) ────────────
    parseExpression(stopAtBrace = false) {
      const expr = this.parseBinaryExpr(0, stopAtBrace);
      // Python-style ternary: value if condition else otherwise
      if (this.at(TT.Keyword, "if")) {
        const ln = this.cur().line;
        this.advance(); // eat 'if'
        const cond = this.parseBinaryExpr(0, stopAtBrace);
        this.eat(TT.Keyword, "else");
        const alt = this.parseExpression(stopAtBrace);
        return Node.TernaryExpr(cond, expr, alt, ln);
      }
      return expr;
    }

    parseBinaryExpr(minPrec, stopAtBrace) {
      let left = this.parseUnary(stopAtBrace);

      while (true) {
        const t    = this.cur();
        let   type = t.type;
        if (t.type === TT.Keyword && t.val === "and") type = TT.AmpAmp;
        if (t.type === TT.Keyword && t.val === "or")  type = TT.PipePipe;

        const prec = PREC[type];
        if (prec === undefined || prec <= minPrec) break;
        if (stopAtBrace && t.type === TT.LBrace) break;

        this.advance();

        // ** is right-associative (recurse with same precedence)
        const nextPrec = type === TT.StarStar ? prec - 1 : prec;
        const right = this.parseBinaryExpr(nextPrec, stopAtBrace);

        const opStr = (type === TT.AmpAmp)    ? "&&"
                    : (type === TT.PipePipe)   ? "||"
                    : (type === TT.SlashSlash) ? null  // floor div special
                    : t.val;

        if (type === TT.AmpAmp || type === TT.PipePipe) {
          left = Node.LogicalExpr(opStr, left, right, t.line);
        } else if (type === TT.SlashSlash) {
          // floor division: Math.floor(a / b)
          left = Node.BinaryExpr("//", left, right, t.line);
        } else {
          left = Node.BinaryExpr(opStr, left, right, t.line);
        }
      }
      return left;
    }

    parseUnary(stopAtBrace) {
      const t = this.cur();
      if (t.type === TT.Bang || (t.type === TT.Keyword && t.val === "not")) {
        this.advance();
        return Node.UnaryExpr("!", this.parseUnary(stopAtBrace), t.line);
      }
      if (t.type === TT.Minus) {
        this.advance();
        return Node.UnaryExpr("-", this.parseUnary(stopAtBrace), t.line);
      }
      if (t.type === TT.Plus) {
        this.advance();
        return Node.UnaryExpr("+", this.parseUnary(stopAtBrace), t.line);
      }
      // Prefix ++ / --
      if (t.type === TT.PlusPlus || t.type === TT.MinusMinus) {
        this.advance();
        const op = t.type === TT.PlusPlus ? "++" : "--";
        return Node.UnaryExpr(op, this.parseUnary(stopAtBrace), t.line);
      }
      // typeof
      if (t.type === TT.Keyword && t.val === "typeof") {
        this.advance();
        return Node.UnaryExpr("typeof", this.parseUnary(stopAtBrace), t.line);
      }
      return this.parsePostfix(stopAtBrace);
    }

    parsePostfix(stopAtBrace) {
      let expr = this.parsePrimary(stopAtBrace);

      while (true) {
        const t = this.cur();
        if (stopAtBrace && t.type === TT.LBrace) break;

        // Property access: expr.prop
        if (t.type === TT.Dot) {
          this.advance();
          // Allow keyword names as property names (e.g., obj.delete, obj.in)
          let propName;
          if (this.at(TT.Ident) || this.at(TT.Keyword)) {
            propName = this.advance().val;
          } else {
            throw new ParseError(`Expected property name after '.'`, t.line);
          }
          expr = Node.MemberExpr(expr, Node.Identifier(propName, t.line), false, t.line);
          continue;
        }
        // Computed access: expr[key]
        if (t.type === TT.LBracket) {
          this.advance();
          const key = this.parseExpression();
          this.eat(TT.RBracket);
          expr = Node.MemberExpr(expr, key, true, t.line);
          continue;
        }
        // Call: expr(args)
        if (t.type === TT.LParen) {
          const args = this.parseArgList();
          expr = Node.CallExpr(expr, args, t.line);
          continue;
        }
        // Postfix ++ / --
        if (t.type === TT.PlusPlus || t.type === TT.MinusMinus) {
          this.advance();
          const op = t.type === TT.PlusPlus ? "++" : "--";
          expr = Node.PostfixExpr(op, expr, t.line);
          continue;
        }
        break;
      }
      return expr;
    }

    parseArgList() {
      this.eat(TT.LParen);
      const args = [];
      while (!this.at(TT.RParen) && !this.at(TT.EOF)) {
        this.skipNewlines();
        if (this.at(TT.RParen)) break;
        args.push(this.parseExpression());
        this.skipNewlines();
        if (this.at(TT.Comma)) this.advance();
      }
      this.eat(TT.RParen);
      return args;
    }

    parsePrimary(stopAtBrace) {
      const t = this.cur();

      if (t.type === TT.Number) { this.advance(); return Node.NumberLit(t.val, t.line); }
      if (t.type === TT.String) { this.advance(); return Node.StringLit(t.val, t.line); }
      if (t.type === TT.TemplateLit) { this.advance(); return Node.TemplateLit(t.val, t.line); }
      if (t.type === TT.Bool)   { this.advance(); return Node.BoolLit(t.val === "true", t.line); }
      if (t.type === TT.Null)   { this.advance(); return Node.NullLit(t.line); }
      if (t.type === TT.Undefined) { this.advance(); return Node.UndefinedLit(t.line); }

      // Grouping
      if (t.type === TT.LParen) {
        this.advance();
        const expr = this.parseExpression();
        this.eat(TT.RParen);
        return expr;
      }

      // Array literal
      if (t.type === TT.LBracket) { return this.parseArrayLit(); }

      // Object literal
      if (t.type === TT.LBrace) {
        if (stopAtBrace) {
          throw new ParseError(
            "Unexpected '{' — did you forget to close a condition before the block?",
            t.line
          );
        }
        return this.parseObjectLit();
      }

      // DOM selector shorthand: __sel_xxx
      if (t.type === TT.Ident && t.val.startsWith("__sel_")) {
        this.advance();
        return Node.Selector(t.val.slice(6), t.line);
      }

      // Keyword-as-expression: log, print, wait, getInput, not, typeof
      if (t.type === TT.Keyword) {
        // log / print
        if (t.val === "log" || t.val === "print") {
          this.advance();
          const ln = t.line;
          let args;
          if (this.at(TT.LParen)) {
            args = this.parseArgList();
          } else {
            // log without parens: consume rest of line as single expression
            args = [this.parseExpression()];
          }
          const callee = Node.MemberExpr(
            Node.Identifier("console", ln), Node.Identifier("log", ln), false, ln
          );
          return Node.CallExpr(callee, args, ln);
        }

        if (t.val === "wait") {
          this.advance();
          let args;
          if (this.at(TT.LParen)) {
            args = this.parseArgList();
          } else {
            args = [this.parsePrimary(stopAtBrace)];
          }
          return Node.CallExpr(Node.Identifier("__wait", t.line), args, t.line);
        }

        if (t.val === "getInput") {
          this.advance();
          let args = [];
          if (this.at(TT.LParen)) {
            args = this.parseArgList();
          } else if (this.at(TT.String) || this.at(TT.Ident)) {
            args = [this.parsePrimary(stopAtBrace)];
          }
          return Node.CallExpr(Node.Identifier("__input", t.line), args, t.line);
        }

        if (t.val === "not") {
          this.advance();
          return Node.UnaryExpr("!", this.parseUnary(stopAtBrace), t.line);
        }

        throw new ParseError(`Unexpected keyword '${t.val}' in expression`, t.line);
      }

      // Regular identifier
      if (t.type === TT.Ident) {
        this.advance();
        return Node.Identifier(t.val, t.line);
      }

      throw new ParseError(
        `Unexpected token '${t.val ?? t.type}' in expression`,
        t.line
      );
    }

    parseArrayLit() {
      const ln = this.cur().line;
      this.eat(TT.LBracket);
      const elements = [];
      while (!this.at(TT.RBracket) && !this.at(TT.EOF)) {
        this.skipNewlines();
        if (this.at(TT.RBracket)) break;
        elements.push(this.parseExpression());
        this.skipNewlines();
        if (this.at(TT.Comma)) this.advance();
      }
      this.eat(TT.RBracket);
      return Node.ArrayLit(elements, ln);
    }

    parseObjectLit() {
      const ln = this.cur().line;
      this.eat(TT.LBrace);
      const props = [];
      while (!this.at(TT.RBrace) && !this.at(TT.EOF)) {
        this.skipNewlines();
        if (this.at(TT.RBrace)) break;
        let key;
        if (this.at(TT.Ident) || this.at(TT.Keyword)) {
          key = this.advance().val;
        } else if (this.at(TT.String)) {
          key = this.advance().val;
        } else if (this.at(TT.Number)) {
          key = this.advance().val;
        } else {
          throw new ParseError(`Expected object key, got '${this.cur().val}'`, this.cur().line);
        }
        this.eat(TT.Colon);
        const val = this.parseExpression();
        props.push({ key, val });
        this.skipNewlines();
        if (this.at(TT.Comma)) this.advance();
      }
      this.eat(TT.RBrace);
      return Node.ObjectLit(props, ln);
    }
  }

  // ─────────────────────────────────────────────
  // 5.  CODE GENERATOR  (AST → JavaScript)
  // ─────────────────────────────────────────────

  // CSS style property shortcut mappings
  // Allows: box.style.bg, box.style.fg, box.style.size, etc.
  const STYLE_SHORTCUTS = {
    bg:           "backgroundColor",
    fg:           "color",
    color:        "color",
    size:         "fontSize",
    fontSize:     "fontSize",
    weight:       "fontWeight",
    fontWeight:   "fontWeight",
    border:       "border",
    radius:       "borderRadius",
    borderRadius: "borderRadius",
    padding:      "padding",
    margin:       "margin",
    width:        "width",
    height:       "height",
    display:      "display",
    opacity:      "opacity",
    transform:    "transform",
    transition:   "transition",
    shadow:       "boxShadow",
    boxShadow:    "boxShadow",
    cursor:       "cursor",
    overflow:     "overflow",
    position:     "position",
    top:          "top",
    left:         "left",
    right:        "right",
    bottom:       "bottom",
    zIndex:       "zIndex",
    flex:         "flex",
    gap:          "gap",
    align:        "alignItems",
    justify:      "justifyContent",
    visibility:   "visibility",
    outline:      "outline",
    textDecor:    "textDecoration",
    lineHeight:   "lineHeight",
    letterSpacing:"letterSpacing",
    maxWidth:     "maxWidth",
    minWidth:     "minWidth",
    maxHeight:    "maxHeight",
    minHeight:    "minHeight",
  };

// ── DB-bridge builtins that the compiler must auto-await, so Lipi authors
// never write Promise/await boilerplate for roccoDB calls.
// dbOnChange is intentionally excluded — it returns an unsubscribe function
// synchronously, it isn't a one-shot awaitable result.
const DB_ASYNC_BUILTINS = new Set(["dbInsert", "dbGet", "dbUpload"]);

// ── RUN-SESSION REGISTRY ─────────────────────────────────────────────────
// [FIX-CRITICAL] Repeated RUN clicks used to leak dbOnChange EventSource
// connections: every run re-executed top-level `dbOnChange(...)` calls in
// the user's script, but nothing ever closed the *previous* run's stream,
// so N clicks left N-1 stale SSE connections silently double/triple firing
// callbacks against a preview DOM that no longer existed. Lipi.run() now
// tears this registry down synchronously before compiling+executing new
// code, and dbOnChange registers itself here instead of just returning an
// orphaned unsubscribe function.
const _runSession = {
  id: 0,
  subscriptions: new Set(), // Set<() => void>
  register(unsubscribe) {
    this.subscriptions.add(unsubscribe);
    return () => this.subscriptions.delete(unsubscribe);
  },
  teardown() {
    this.id += 1;
    for (const unsub of this.subscriptions) {
      try { unsub(); } catch (_) { /* already closed */ }
    }
    this.subscriptions.clear();
    return this.id;
  },
};

class CodeGen {
  constructor(asyncFunctions) {
    // Set of user-declared async function names from the parser
    this.asyncFunctions = asyncFunctions || new Set();
  }

    generate(ast) {
      const body = ast.body.map(n => "  " + this.stmt(n)).join("\n");
      // Wrap in async IIFE so `await` works at top level.
      // Errors are caught and shown via Lipi.showError.
      return `(async () => {\ntry {\n${body}\n} catch(__e) { console.error(__e); Lipi.showError(__e); }\n})().catch((__e) => { console.error(__e); Lipi.showError(__e); });`;
    }

    // ── Statements ─────────────────────────
    stmt(node) {
      switch (node.type) {
        case "VarDecl":    return this.varDecl(node);
        case "Assign":     return this.assign(node);
        case "IfStmt":     return this.ifStmt(node);
        case "WhileStmt":  return this.whileStmt(node);
        case "ForInStmt":  return this.forInStmt(node);
        case "FuncDecl":   return this.funcDecl(node);
        case "ReturnStmt": return this.returnStmt(node);
        case "OnEvent":    return this.onEvent(node);
        case "ExprStmt":   return this.exprStmt(node);
        case "DeleteStmt": return this.deleteStmt(node);
        case "AssertStmt": return this.assertStmt(node);
        case "BreakStmt":  return "break;";
        case "ContinueStmt": return "continue;";
        default:
          throw new Error(`CodeGen: unknown statement type '${node.type}'`);
      }
    }

    varDecl(node) {
      return `let ${node.name} = ${this.expr(node.init)};`;
    }

    assign(node) {
      const target = this.expr(node.target);
      const value  = this.expr(node.value);
      // Handle //= as floor division assignment
      if (node.op === "//=") {
        return `${target} = Math.floor(${target} / ${value});`;
      }
      // Handle **= as exponentiation assignment
      if (node.op === "**=") {
        return `${target} = (${target} ** ${value});`;
      }
      return `${target} ${node.op} ${value};`;
    }

    ifStmt(node) {
      const parts = node.branches.map((b, i) => {
        const kw = i === 0 ? "if" : "else if";
        return `${kw} (${this.expr(b.cond)}) ${this.block(b.body)}`;
      });
      if (node.alt) parts.push(`else ${this.block(node.alt)}`);
      return parts.join(" ");
    }

    whileStmt(node) {
      return `while (${this.expr(node.test)}) ${this.block(node.body)}`;
    }

    forInStmt(node) {
      // For arrays: for i in arr  → iterate values
      // For objects: for k in obj → iterate keys
      // We generate smart iteration: if iterable has Symbol.iterator, use for...of;
      // otherwise use Object.keys().
      const iterableCode = this.expr(node.iterable);
      // We use a runtime helper to handle both cases cleanly.
      return `for (let ${node.iter} of __iterKeys(${iterableCode})) ${this.block(node.body)}`;
    }

    funcDecl(node) {
      const params = node.params.join(", ");
      return `async function ${node.name}(${params}) ${this.block(node.body)}`;
    }

    returnStmt(node) {
      return node.value ? `return ${this.expr(node.value)};` : `return;`;
    }

    onEvent(node) {
      // Resolve target expression
      let targetCode;
      if (node.target.startsWith("__sel_")) {
        // DOM selector
        targetCode = `__lipiSel('#${node.target.slice(6)}')`;
      } else {
        // Plain variable/expression — use the variable name directly
        // The variable must be defined at this scope
        targetCode = node.target;
      }
      const bodyCode = this.block(node.body);
      // Guard against null target with helpful error
      return `(function() { const __t = ${targetCode}; if (!__t) { console.error("Lipi: 'on' target not found: ${node.target}"); return; } __t.addEventListener('${node.event}', async () => ${bodyCode}); })();`;
    }

    deleteStmt(node) {
      return `delete ${this.expr(node.target)};`;
    }

    assertStmt(node) {
      const cond = this.expr(node.cond);
      const msg  = node.msg ? this.expr(node.msg) : JSON.stringify(`Assertion failed: ${cond}`);
      return `if (!(${cond})) { throw new Error(${msg}); }`;
    }

    exprStmt(node) {
      return `${this.expr(node.expr)};`;
    }

    block(node) {
      const stmts = node.body.map(s => "    " + this.stmt(s)).join("\n");
      return `{\n${stmts}\n  }`;
    }

    // ── Expressions ──────────────────────────
    expr(node) {
      switch (node.type) {
        case "NumberLit":    return node.val;
        case "StringLit":    return JSON.stringify(node.val);
        case "TemplateLit":  return this.templateLit(node);
        case "BoolLit":      return node.val ? "true" : "false";
        case "NullLit":      return "null";
        case "UndefinedLit": return "undefined";
        case "Identifier":   return this.ident(node);
        case "Selector":     return `__lipiSel('#${node.id}')`;
        case "ArrayLit":     return this.arrayLit(node);
        case "ObjectLit":    return this.objectLit(node);
        case "BinaryExpr":   return this.binaryExpr(node);
        case "LogicalExpr":  return this.logicalExpr(node);
        case "UnaryExpr":    return this.unaryExpr(node);
        case "PostfixExpr":  return this.postfixExpr(node);
        case "TernaryExpr":  return this.ternaryExpr(node);
        case "CallExpr":     return this.callExpr(node);
        case "MemberExpr":   return this.memberExpr(node);
        default:
          throw new Error(`CodeGen: unknown expression type '${node.type}'`);
      }
    }

    ident(node) {
      // No mapping needed — wait/getInput are now parsed directly as __wait/__input nodes
      return node.name;
    }

    templateLit(node) {
      // Convert Lipi template {expr} to JS ${expr}
      // The raw string has { and } — we replace { with ${ for JS template literals.
      // We need to be careful: only replace { that aren't already ${ 
      const jsRaw = node.raw.replace(/(?<!\$)\{/g, "${");
      return `\`${jsRaw}\``;
    }

    arrayLit(node) {
      return `[${node.elements.map(e => this.expr(e)).join(", ")}]`;
    }

    objectLit(node) {
      const props = node.props.map(({ key, val }) => {
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(String(key))
          ? key
          : JSON.stringify(key);
        return `${safeKey}: ${this.expr(val)}`;
      });
      return `({ ${props.join(", ")} })`;
    }

    binaryExpr(node) {
      if (node.op === "//") {
        // Floor division
        return `Math.floor((${this.expr(node.left)}) / (${this.expr(node.right)}))`;
      }
      if (node.op === "**") {
        return `((${this.expr(node.left)}) ** (${this.expr(node.right)}))`;
      }
      // Use === and !== for equality checks (safer JS semantics)
      const op = node.op === "==" ? "===" : node.op === "!=" ? "!==" : node.op;
      return `(${this.expr(node.left)} ${op} ${this.expr(node.right)})`;
    }

    logicalExpr(node) {
      return `(${this.expr(node.left)} ${node.op} ${this.expr(node.right)})`;
    }

    unaryExpr(node) {
      if (node.op === "typeof") {
        return `(typeof ${this.expr(node.arg)})`;
      }
      // Space after unary minus to prevent '--' ambiguity
      const space = node.op === "-" ? " " : "";
      // Prefix ++ and -- don't need space
      if (node.op === "++" || node.op === "--") {
        return `(${node.op}${this.expr(node.arg)})`;
      }
      return `(${node.op}${space}${this.expr(node.arg)})`;
    }

    postfixExpr(node) {
      return `(${this.expr(node.arg)}${node.op})`;
    }

    ternaryExpr(node) {
      return `(${this.expr(node.cond)} ? ${this.expr(node.cons)} : ${this.expr(node.alt)})`;
    }

    callExpr(node) {
      const callee = this.expr(node.callee);
      const args   = node.args.map(a => this.expr(a)).join(", ");

      // Determine if this call needs `await`:
      // 1. __wait and __input are always awaited (async runtime helpers)
      // 2. User-declared functions (tracked by parser) are always awaited
      // 3. Everything else (console.log, Math.max, DOM methods, etc.) is NOT awaited
      const needsAwait = this._needsAwait(node.callee);

      if (needsAwait) {
        return `(await ${callee}(${args}))`;
      }
      return `${callee}(${args})`;
    }

    _needsAwait(calleeNode) {
      // Direct identifier: __wait, __input, roccoDB builtins, or
      // user-declared async functions.
      if (calleeNode.type === "Identifier") {
        const name = calleeNode.name;
        if (name === "__wait" || name === "__input") return true;
        if (DB_ASYNC_BUILTINS.has(name)) return true;
        if (this.asyncFunctions.has(name)) return true;
        return false;
      }
      // Member expressions: never await (console.log, obj.method, etc.)
      // Users can always call async methods directly if needed
      return false;
    }

    memberExpr(node) {
      const obj = this.expr(node.obj);

      if (node.computed) {
        return `${obj}[${this.expr(node.prop)}]`;
      }

      // Non-computed property access
      const propName = node.prop.name ?? this.expr(node.prop);

      // Style shortcut interception: expr.style.xxx
      // When we see something like `__prev_expr.style` being accessed,
      // we check if propName is a style shortcut.
      // Strategy: check if parent is a .style member.
      // We handle this by checking if `obj` ends in `.style`
      if (obj.endsWith(".style") || obj.match(/\.style$/)) {
        const mapped = STYLE_SHORTCUTS[propName];
        if (mapped) {
          return `${obj}.${mapped}`;
        }
      }

      return `${obj}.${propName}`;
    }
  }

  // ─────────────────────────────────────────────
  // 6.  RUNTIME ENVIRONMENT
  // ─────────────────────────────────────────────

  // Runtime helper: smart iteration
  // - Arrays → iterate values
  // - Objects → iterate keys
  // - Strings → iterate characters
  // - Numbers → iterate 0..n-1  (like range)
  function __iterKeys(obj) {
    if (obj === null || obj === undefined) return [];
    if (typeof obj === "number") {
      const a = [];
      for (let i = 0; i < obj; i++) a.push(i);
      return a;
    }
    if (Array.isArray(obj) || typeof obj === "string") return obj;
    if (typeof obj[Symbol.iterator] === "function") return obj;
    return Object.keys(obj);
  }
  window.__iterKeys = __iterKeys;

  const Lipi = {
    // DOM selector helper
    $: (sel) => {
      const id = sel.replace(/^#/, "");
      const direct = document.getElementById(id);
      if (direct) return direct;
      const roots = [
        document.getElementById("app-preview"),
        document.getElementById("fs-body"),
      ].filter(Boolean);
      for (const root of roots) {
        const el = root.querySelector(sel);
        if (el) return el;
      }
      return null;
    },

    init: () => {
      // ── Core async helpers ──
      window.__wait  = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
      window.__input = (promptText) =>
        new Promise((resolve) => {
          const consoleDiv = document.getElementById("console");
          if (!consoleDiv) {
            resolve(window.prompt(promptText || "Input:") ?? "");
            return;
          }
          const line = document.createElement("div");
          line.className = "mb-1 flex items-center gap-2 font-mono text-xs";
          line.innerHTML = `<span class="text-violet-400 shrink-0">? ${promptText || "Input:"}</span>`;
          const inp = document.createElement("input");
          inp.className = "bg-transparent border-none outline-none text-white flex-1 font-mono text-xs";
          inp.style.caretColor = "#8b5cf6";
          inp.autocomplete = "off";
          line.appendChild(inp);
          consoleDiv.appendChild(line);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
          inp.focus();
          inp.onkeydown = (e) => {
            if (e.key === "Enter") {
              const val = inp.value;
              line.innerHTML = `<span class="text-violet-400 shrink-0">? ${promptText || "Input:"}</span><span class="text-white ml-2">${val}</span>`;
              resolve(val);
            }
          };
        });

      // ── DOM selector available as $ ──
      window.__lipiSel = (sel) => Lipi.$(sel);

      // ─────────────────────────────────────────────
      // roccoDB BRIDGE — dbInsert / dbGet / dbUpload / dbOnChange
      // Talks to the Express bridge (server/db-bridge.js) since roccoDB
      // itself only runs inside Node, never in the browser.
      // ─────────────────────────────────────────────

      // Base URL for the bridge. Override before Lipi.init() runs, e.g.
      // window.LIPI_DB_API = 'https://api.myapp.com/db';
      window.LIPI_DB_API = window.LIPI_DB_API || 'http://127.0.0.1:4000/api/db';

      async function _dbAuthToken() {
        try {
          if (typeof window._SyncAPI?.getIdToken === 'function') {
            return await window._SyncAPI.getIdToken();
          }
        } catch (e) {
          console.warn(`[roccoDB] Could not read auth token: ${e.message}`);
        }
        return null;
      }

      async function _dbFetch(path, options = {}) {
        const token   = await _dbAuthToken();
        const headers = Object.assign(
          { 'Content-Type': 'application/json' },
          options.headers || {}
        );
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let res;
        try {
          res = await fetch(`${window.LIPI_DB_API}${path}`, { ...options, headers });
        } catch (netErr) {
          throw new Error(`network error reaching db bridge (${netErr.message})`);
        }

        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json()).error || ''; } catch (_) {}
          throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
        }
        return res.json();
      }

      // dbInsert(collection, doc) → id
      window.dbInsert = async (collection, doc) => {
        try {
          if (typeof collection !== 'string' || !collection) {
            throw new Error('dbInsert: "collection" must be a non-empty string');
          }
          if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
            throw new Error('dbInsert: "doc" must be an object');
          }
          const data = await _dbFetch('/insert', {
            method: 'POST',
            body: JSON.stringify({ collection, doc }),
          });
          return data.id;
        } catch (e) {
          console.error(`[roccoDB] dbInsert("${collection}") failed: ${e.message}`);
          throw e;
        }
      };

      // dbGet(collection, id) → object | null
      window.dbGet = async (collection, id) => {
        try {
          if (typeof collection !== 'string' || !collection) {
            throw new Error('dbGet: "collection" must be a non-empty string');
          }
          if (!id) throw new Error('dbGet: "id" is required');
          const qs = new URLSearchParams({ collection, id });
          const data = await _dbFetch(`/get?${qs.toString()}`, { method: 'GET' });
          return data.doc ?? null;
        } catch (e) {
          console.error(`[roccoDB] dbGet("${collection}", "${id}") failed: ${e.message}`);
          throw e;
        }
      };

      // dbUpload(fileOrSelector, collection?, meta?) → storage ref
      // fileOrSelector: a File/Blob, a "#fileInput" selector, or an <input type=file>
      window.dbUpload = async (fileOrSelector, collection, meta) => {
        let file = fileOrSelector;
        try {
          if (typeof fileOrSelector === 'string') {
            const el = Lipi.$(fileOrSelector);
            file = el?.files?.[0];
          } else if (typeof HTMLInputElement !== 'undefined' && fileOrSelector instanceof HTMLInputElement) {
            file = fileOrSelector.files?.[0];
          }
          if (!(file instanceof Blob)) {
            throw new Error('expected a File/Blob, a file-input selector, or an <input type="file"> element');
          }

          const token = await _dbAuthToken();
          const form  = new FormData();
          form.append('file', file, file.name || 'upload.bin');
          if (collection) form.append('collection', collection);
          if (meta)       form.append('meta', JSON.stringify(meta));

          const headers = {};
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const res = await fetch(`${window.LIPI_DB_API}/upload`, {
            method: 'POST', headers, body: form,
          });
          if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).error || ''; } catch (_) {}
            throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
          }
          const data = await res.json();
          return data.ref;
        } catch (e) {
          console.error(`[roccoDB] dbUpload failed: ${e.message}`);
          throw e;
        }
      };

      // dbOnChange(collection, callback) → unsubscribe()
      // NOT auto-awaited by the compiler — it's a subscription, not a
      // one-shot value. Reconnects with backoff if the stream drops.
      window.dbOnChange = (collection, callback) => {
        if (typeof collection !== 'string' || !collection) {
          console.error('[roccoDB] dbOnChange: "collection" must be a non-empty string');
          return () => {};
        }
        if (typeof callback !== 'function') {
          console.error('[roccoDB] dbOnChange: a callback function is required');
          return () => {};
        }

        let es        = null;
        let closed     = false;
        let retryDelay = 1000;
        // Bind this subscription to the run that created it. If a new RUN
        // starts (session id bumps), stop retrying/reconnecting even if a
        // stray timeout fires — prevents cross-session callback bleed.
        const mySessionId = _runSession.id;
        const deregister = _runSession.register(() => { closed = true; es?.close(); });

        const connect = async () => {
          if (closed || _runSession.id !== mySessionId) return;
          try {
            const token = await _dbAuthToken();
            const qs = new URLSearchParams({ collection });
            if (token) qs.set('token', token); // EventSource can't send headers
            es = new EventSource(`${window.LIPI_DB_API}/stream?${qs.toString()}`);

            es.onopen = () => { retryDelay = 1000; };
            es.onmessage = (evt) => {
              try { callback(JSON.parse(evt.data)); }
              catch (e) { console.error(`[roccoDB] dbOnChange("${collection}") bad payload: ${e.message}`); }
            };
            es.onerror = () => {
              console.warn(`[roccoDB] dbOnChange("${collection}") connection lost — retrying in ${retryDelay}ms`);
              es?.close();
              if (!closed) setTimeout(connect, Math.min((retryDelay *= 2), 15000));
            };
          } catch (e) {
            console.error(`[roccoDB] dbOnChange("${collection}") failed to connect: ${e.message}`);
            if (!closed) setTimeout(connect, Math.min((retryDelay *= 2), 15000));
          }
        };
        connect();

        return () => { closed = true; es?.close(); deregister(); };
      };

      // ── Standard builtins ──
      window.range = (start, end, step) => {
        if (end === undefined) { end = start; start = 0; }
        step = step ?? 1;
        const a = [];
        if (step > 0) { for (let i = start; i < end; i += step) a.push(i); }
        else          { for (let i = start; i > end; i += step) a.push(i); }
        return a;
      };

      window.len = (x) => {
        if (x === null || x === undefined) return 0;
        if (typeof x === "string" || Array.isArray(x)) return x.length;
        if (typeof x === "object") return Object.keys(x).length;
        return 0;
      };

      window.keys   = (obj) => Object.keys(obj ?? {});
      window.values = (obj) => Object.values(obj ?? {});
      window.items  = (obj) => Object.entries(obj ?? {});
      window.has    = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

      window.str    = (v) => String(v ?? "");
      window.int    = (v) => parseInt(v, 10);
      window.float  = (v) => parseFloat(v);
      window.bool   = (v) => Boolean(v);
      window.num    = (v) => Number(v);

      window.abs    = (v) => Math.abs(v);
      window.max    = (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.max(...args[0]) : Math.max(...args);
      window.min    = (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.min(...args[0]) : Math.min(...args);
      window.round  = (v, d) => d !== undefined ? parseFloat(v.toFixed(d)) : Math.round(v);
      window.floor  = (v) => Math.floor(v);
      window.ceil   = (v) => Math.ceil(v);
      window.sqrt   = (v) => Math.sqrt(v);
      window.pow    = (b, e) => Math.pow(b, e);
      window.random = (a, b) => {
        if (a === undefined) return Math.random();
        if (b === undefined) return Math.floor(Math.random() * a);
        return Math.floor(Math.random() * (b - a) + a);
      };

      window.type   = (v) => {
        if (v === null) return "null";
        if (Array.isArray(v)) return "array";
        return typeof v;
      };

      // Array helpers
      window.push   = (arr, ...items) => { arr.push(...items); return arr; };
      window.pop    = (arr) => arr.pop();
      window.append = (arr, item) => { arr.push(item); return arr; };
      window.prepend= (arr, item) => { arr.unshift(item); return arr; };
      window.remove = (arr, idx) => arr.splice(idx, 1);
      window.join   = (arr, sep) => arr.join(sep ?? ",");
      window.split  = (str, sep) => str.split(sep ?? "");
      window.slice  = (arr, a, b) => arr.slice(a, b);
      window.reverse= (arr) => [...arr].reverse();
      window.sort   = (arr, fn) => [...arr].sort(fn);
      window.filter = (arr, fn) => arr.filter(fn);
      window.map    = (arr, fn) => arr.map(fn);
      window.find   = (arr, fn) => arr.find(fn);
      window.includes=(arr, v) => arr.includes(v);
      window.indexOf = (arr, v) => arr.indexOf(v);
      window.flat   = (arr, d) => arr.flat(d ?? 1);
      window.sum    = (arr) => arr.reduce((a, b) => a + b, 0);
      window.avg    = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      // String helpers
      window.upper  = (s) => String(s).toUpperCase();
      window.lower  = (s) => String(s).toLowerCase();
      window.trim   = (s) => String(s).trim();
      window.replace= (s, a, b) => String(s).replaceAll(a, b);
      window.startsWith = (s, p) => String(s).startsWith(p);
      window.endsWith   = (s, p) => String(s).endsWith(p);
      window.contains   = (s, p) => String(s).includes(p);
      window.pad    = (s, n, c) => String(s).padStart(n, c ?? " ");
      window.repeat = (s, n) => String(s).repeat(n);

      // Object helpers
      window.merge  = (...objs) => Object.assign({}, ...objs);
      window.copy   = (obj) => Array.isArray(obj) ? [...obj] : { ...obj };
      window.deepCopy= (obj) => JSON.parse(JSON.stringify(obj));
      window.toJSON = (obj) => JSON.stringify(obj, null, 2);
      window.fromJSON=(s) => JSON.parse(s);

      // Time / Date helpers
      window.now    = () => Date.now();
      window.timestamp = () => new Date().toISOString();

      // Expose common globals directly
      window.Math_   = Math;    // in case user wrote Math_ in Lipi
      // Math is already global, as are JSON, Object, Array, etc.
      // We also expose them as lowercase aliases for Python-style feel:
      window.PI     = Math.PI;
      window.E      = Math.E;
      window.INF    = Infinity;
      window.NaN_   = NaN;

      // DOM creation helpers
      window.createElement = (tag, props, ...children) => {
        const el = document.createElement(tag);
        if (props) {
          for (const [k, v] of Object.entries(props)) {
            if (k === "class" || k === "className") el.className = v;
            else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
            else el.setAttribute(k, v);
          }
        }
        for (const child of children) {
          if (child === null || child === undefined) continue;
          if (typeof child === "string") el.appendChild(document.createTextNode(child));
          else el.appendChild(child);
        }
        return el;
      };

      window.appendTo = (parent, child) => {
        if (typeof parent === "string") parent = Lipi.$(parent);
        if (parent && child) parent.appendChild(child);
      };

      window.setHTML = (el, html) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerHTML = html;
      };

      window.setText = (el, text) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerText = String(text);
      };

      window.getHTML = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.innerHTML : "";
      };

      window.getText = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.innerText : "";
      };

      window.addClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.add(...cls.split(" ").filter(Boolean));
      };

      window.removeClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.remove(...cls.split(" ").filter(Boolean));
      };

      window.toggleClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.toggle(cls);
      };

      window.hasClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.classList.contains(cls) : false;
      };

      window.queryAll = (sel, root) => {
        const r = root ? (typeof root === "string" ? Lipi.$(root) : root) : document.getElementById("app-preview") || document;
        return r ? Array.from(r.querySelectorAll(sel)) : [];
      };

      window.show = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.style.display = "";
      };

      window.hide = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.style.display = "none";
      };

      window.clear = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerHTML = "";
      };

      // Sleep alias
      window.sleep = window.__wait;

      // $ shorthand
      window.$ = (s) => Lipi.$(s);

      console.log("[lipi.info] Lipi Engine v4.0 ready (Production AST)");
    },

    // Compile Lipi source → JavaScript string
    compile: (code) => {
      const lexer  = new Lexer(code);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens);
      const ast    = parser.parse();
      return new CodeGen(parser.asyncFunctions).generate(ast);
    },

    // Compile and execute Lipi source
    run: (code) => {
      document.getElementById("lipi-runtime-error")?.remove();
      // [FIX-CRITICAL] Close every dbOnChange stream (and any other
      // registered session resource) from the previous run BEFORE the new
      // one starts. This is what makes repeated RUN clicks safe: no
      // duplicate SSE subscriptions, no callbacks firing twice, no stale
      // sessions still listening in the background.
      _runSession.teardown();
      let js = "";
      try {
        js = Lipi.compile(code);
        // Use AsyncFunction to run the async IIFE properly
        // new Function wraps our IIFE which has its own error handling
        const fn = new Function("__iterKeys", "__lipiSel", js);
        fn(__iterKeys, (sel) => Lipi.$(sel));
      } catch (e) {
        // Attach compiled JS snippet for JS syntax errors to help debug
        if (e instanceof SyntaxError && js) {
          e.message += `\n\n[Compiled JS snippet]:\n${js.slice(0, 500)}`;
        }
        Lipi.showError(e);
      }
    },

    // Build a full, self-contained HTML document that runs a Lipi project
    // outside the Studio shell (no CodeMirror, no sidebar, no AI panel).
    // Used by both "Open App" (blob URL in a new tab) and "Export App"
    // (bundled into a downloadable zip) so the two features can never drift
    // apart from each other.
    // lipiJsSource: the full text of lipi.js, inlined so the exported
    // bundle has zero external runtime dependencies.
    buildStandaloneHtml: ({ name, html, lipi, lipiJsSource, dbApiUrl }) => {
      const safeName = String(name || "LIPI App").replace(/</g, "&lt;");
      const escapedHtml = String(html || "");
      const safeLipiJsSource = String(lipiJsSource || '')
       .replace(/<\/script/gi, '<\\/script');
      const engineTag = lipiJsSource
    ? `<script>\n${safeLipiJsSource}\n</script>`
    : `<script src="./lipi.js"></script>`;
      const dbApiLine = dbApiUrl
        ? `<script>window.LIPI_DB_API = ${JSON.stringify(dbApiUrl)};</script>`
        : "";
      const lipiSourceJson = JSON.stringify(String(lipi || ""));
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeName}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;padding:0;min-height:100vh;background:#0a0a0b;}</style>
${dbApiLine}
</head>
<body>
<div id="app-preview">${escapedHtml}</div>
${engineTag}
<script>
  const __lipiSrc = ${lipiSourceJson};
  function __lipiBoot() {
    if (!window.Lipi) { setTimeout(__lipiBoot, 20); return; }
    Lipi.run(__lipiSrc);
  }
  document.addEventListener("DOMContentLoaded", __lipiBoot);
</script>
</body>
</html>`;
    },

    showError: (e) => {
      console.error("[Lipi Error]", e);
      document.getElementById("lipi-runtime-error")?.remove();
      const box = document.createElement("div");
      box.id = "lipi-runtime-error";
      box.style.cssText = [
        "position:fixed", "bottom:20px", "right:20px", "padding:16px",
        "background:#18181b", "color:#f87171", "border-radius:10px",
        "font-family:'JetBrains Mono',monospace", "font-size:12px",
        "z-index:99999", "box-shadow:0 10px 30px rgba(0,0,0,.6)",
        "border:1px solid #7f1d1d", "max-width:440px", "word-break:break-word",
        "line-height:1.6",
      ].join(";");
      const msg = String(e.message || e).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:bold;color:#fff;font-size:13px">⚠️ Lipi Error</span>
          <button onclick="this.parentNode.parentNode.remove()" style="background:none;border:none;color:#71717a;cursor:pointer;font-size:16px;line-height:1;">×</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;color:#fca5a5;font-size:11px">${msg}</pre>`;
      document.body.appendChild(box);
      setTimeout(() => box.parentNode && box.remove(), 10000);
    },
  };

  window.Lipi      = Lipi;
  window.LipyLexer = Lexer;
  window.LipyParser= Parser;
  window.LipyCodeGen=CodeGen;
})();

// Auto-init on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  window.Lipi?.init();
});
