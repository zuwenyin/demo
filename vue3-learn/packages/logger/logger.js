/**
 * 控制台彩色日志工具（TypeScript 版）
 *
 * 浏览器直接 ESM 引入即可：
 *   import { logger, createLogger } from './logger.js'
 *   import './index.js'   // 会自动挂载全局 Logger / log
 *   log.info('hello', { a: 1 })
 *   // 自定义徽章文案与配色
 *   logger.setLabel('info', '信息', { color: '#722ed1', text: '#722ed1' })  // 改全局配置
 *   logger.setLabels({ warn: '警告', error: '错误' })
 *   logger.label('info', '信息', { color: '#722ed1' }).info('只影响这一条') // 不改全局配置
 *
 * 内置样式：trace / debug / log(普通) / info / success / warn / error
 */
/** 数值越大越严重，用于级别过滤 */
const LEVEL_WEIGHT = {
    trace: 10,
    debug: 20,
    log: 30,
    info: 30,
    success: 30,
    warn: 40,
    error: 50,
    off: 100
};
const CONSOLE_METHOD = {
    trace: 'log',
    debug: 'debug',
    log: 'log',
    info: 'log',
    success: 'log',
    warn: 'warn',
    error: 'error'
};
export const THEME = {
    trace: { label: 'TRACE', color: '#08979c', text: '#08979c', ansi: 36 },
    debug: { label: 'DEBUG', color: '#9254de', text: '#722ed1', ansi: 35 },
    log: { label: 'LOG', color: '#909399', text: '#303133', ansi: 37 },
    info: { label: 'INFO', color: '#409eff', text: '#1f6feb', ansi: 36 },
    success: { label: 'SUCCESS', color: '#52c41a', text: '#389e0d', ansi: 32 },
    warn: { label: 'WARN', color: '#e6a23c', text: '#d46b08', ansi: 33 },
    error: { label: 'ERROR', color: '#f56c6c', text: '#cf1322', ansi: 31 }
};
const PREFIX_COLOR = '#34495e';
/** tsconfig 的 types 为空，这里按需取 process.stdout.isTTY 判断终端是否支持颜色 */
function detectRender() {
    const isDom = typeof window !== 'undefined' && typeof window.document !== 'undefined';
    if (isDom)
        return 'css';
    const stdout = globalThis.process?.stdout;
    return stdout?.isTTY ? 'color' : 'plain';
}
const RENDER = detectRender();
function stamp() {
    const date = new Date();
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
function badge(color, radius) {
    return `background:${color};color:#fff;padding:2px 6px;border-radius:${radius};font-weight:600;`;
}
function toText(value) {
    if (typeof value === 'string')
        return value;
    if (value === null)
        return 'null';
    if (value === undefined)
        return 'undefined';
    if (typeof value === 'function')
        return value.name || 'anonymous';
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        // 循环引用等无法序列化的情况
        return String(value);
    }
}
function write(method, args) {
    const fn = console[method] ?? console.log;
    // 用 Reflect 调用，避免直接解绑导致 this 丢失
    Reflect.apply(fn, console, args);
}
/** 取调用栈，stopAt 之上的工具内部帧会被裁掉 */
function captureStack(stopAt) {
    const holder = new Error();
    const capture = Error.captureStackTrace;
    if (capture && stopAt)
        capture(holder, stopAt);
    const lines = (holder.stack ?? '').split('\n');
    // 丢弃首行的 Error 标题，只保留 at 开头的帧
    return lines.filter((line, index) => index !== 0 || /^\s*at\s/.test(line)).join('\n');
}
/** 浅拷贝主题配置，避免派生实例与父实例共用同一个对象 */
function cloneStyles(base) {
    if (!base)
        return undefined;
    const out = {};
    for (const level of Object.keys(base))
        out[level] = { ...base[level] };
    return out;
}
/** 按级别合并主题配置，未覆盖的级别保留原样 */
function mergeStyles(base, extra) {
    const out = { ...base };
    for (const level of Object.keys(extra ?? {})) {
        out[level] = { ...out[level], ...extra?.[level] };
    }
    return out;
}
export function createLogger(prefixOrOptions, options) {
    const conf = {
        prefix: '',
        level: 'trace',
        enabled: true,
        timestamp: false,
        styles: undefined
    };
    if (typeof prefixOrOptions === 'string') {
        conf.prefix = prefixOrOptions;
    }
    else if (prefixOrOptions) {
        Object.assign(conf, prefixOrOptions);
    }
    if (options)
        Object.assign(conf, options);
    function themeOf(level) {
        return { ...THEME[level], ...conf.styles?.[level] };
    }
    function allowed(level) {
        if (!conf.enabled)
            return false;
        const current = LEVEL_WEIGHT[conf.level] ?? LEVEL_WEIGHT.trace;
        return LEVEL_WEIGHT[level] >= current;
    }
    /** 统一输出口 */
    function paint(level, args) {
        if (!allowed(level))
            return;
        const theme = themeOf(level);
        const rest = args.slice(1);
        if (RENDER !== 'css') {
            const head = [
                ...(conf.timestamp ? [stamp()] : []),
                ...(conf.prefix ? [`[${conf.prefix}]`] : []),
                `[${theme.label}]`
            ].join(' ');
            const line = `${head} ${toText(args[0])}`;
            write(CONSOLE_METHOD[level], [RENDER === 'color' ? `\x1b[${theme.ansi}m${line}\x1b[0m` : line, ...rest]);
            return;
        }
        const tokens = [];
        const styles = [];
        if (conf.timestamp) {
            tokens.push(`%c${stamp()}`);
            styles.push('color:#909399;font-size:11px;');
        }
        if (conf.prefix) {
            tokens.push(`%c ${conf.prefix} `);
            styles.push(badge(PREFIX_COLOR, '3px 0 0 3px'));
        }
        tokens.push(`%c ${theme.label} `);
        styles.push(badge(theme.color, conf.prefix ? '0 3px 3px 0' : '3px'));
        tokens.push(`%c ${toText(args[0])}`);
        styles.push(`color:${theme.text};font-weight:600;`);
        write(CONSOLE_METHOD[level], [tokens.join(' '), ...styles, ...rest]);
    }
    function make(level) {
        return (...args) => paint(level, args);
    }
    const counters = new Map();
    const logger = {
        trace: make('trace'),
        debug: make('debug'),
        log: make('log'),
        info: make('info'),
        success: make('success'),
        warn: make('warn'),
        error: make('error'),
        configure: (opts) => {
            Object.assign(conf, opts);
            return logger;
        },
        setLevel: (level) => {
            conf.level = level;
            return logger;
        },
        enable: () => {
            conf.enabled = true;
            return logger;
        },
        disable: () => {
            conf.enabled = false;
            return logger;
        },
        setLabel: (level, label, style) => {
            conf.styles = {
                ...conf.styles,
                [level]: { ...conf.styles?.[level], label, ...style }
            };
            return logger;
        },
        setLabels: (labels) => {
            const next = { ...conf.styles };
            for (const level of Object.keys(labels)) {
                const label = labels[level];
                if (label === undefined)
                    continue;
                next[level] = { ...next[level], label };
            }
            conf.styles = next;
            return logger;
        },
        derive: (options) => {
            // 复制一份 styles，保证派生实例后续改动不会回流到自身
            const cloned = cloneStyles(conf.styles);
            const merged = {
                prefix: conf.prefix,
                level: conf.level,
                enabled: conf.enabled,
                timestamp: conf.timestamp,
                styles: cloned,
                ...options
            };
            // options.styles 按级别与既有配置做浅合并，未覆盖的级别保留原样
            if (options?.styles)
                merged.styles = mergeStyles(cloned, options.styles);
            return createLogger(merged);
        },
        label: (level, text, style) => logger.derive().setLabel(level, text, style),
        group: (title, collapsed = false, level = 'log') => {
            if (!conf.enabled)
                return;
            paint(level, [title]);
            if (collapsed && console.groupCollapsed)
                console.groupCollapsed();
            else if (console.group)
                console.group();
        },
        groupEnd: () => {
            console.groupEnd();
        },
        table: (data, columns) => {
            if (!conf.enabled)
                return;
            paint('log', ['表格数据如下']);
            if (columns)
                console.table(data, columns);
            else
                console.table(data);
        },
        dir: (value) => {
            if (!conf.enabled)
                return;
            console.dir(value);
        },
        stack: (message) => {
            if (!allowed('trace'))
                return;
            paint('trace', [message ?? '调用栈']);
            write(CONSOLE_METHOD.trace, [captureStack(logger.stack)]);
        },
        time: (label = 'timer') => {
            const key = conf.prefix ? `${conf.prefix}:${label}` : label;
            if (console.time)
                console.time(key);
            let ended = false;
            return () => {
                if (ended)
                    return;
                ended = true;
                if (console.timeEnd)
                    console.timeEnd(key);
            };
        },
        timeEnd: (label = 'timer') => {
            const key = conf.prefix ? `${conf.prefix}:${label}` : label;
            console.timeEnd(key);
        },
        count: (label = 'count') => {
            const next = (counters.get(label) ?? 0) + 1;
            counters.set(label, next);
            paint('log', [`${label}: ${next}`]);
        },
        countReset: (label = 'count') => {
            counters.delete(label);
        },
        assert: (condition, message) => {
            if (condition)
                return;
            paint('error', [`断言失败: ${message ?? String(condition)}`]);
        },
        clear: () => {
            console.clear();
        }
    };
    // trace 额外带上调用栈，堆栈里的工具内部帧已过滤
    logger.trace = (...args) => {
        if (!allowed('trace'))
            return;
        paint('trace', args);
        write(CONSOLE_METHOD.trace, [captureStack(logger.trace)]);
    };
    return logger;
}
/** 开箱即用的默认实例 */
export const logger = createLogger();
/**
 * 挂载到全局，方便在没有 import 的 html 内联脚本里直接 log.info()
 */
export function mountGlobal(force = false) {
    const scope = globalThis;
    if (!scope.Logger || force)
        scope.Logger = logger;
    if (!scope.log || force)
        scope.log = logger;
    return logger;
}
export function unmountGlobal() {
    const scope = globalThis;
    delete scope.Logger;
    delete scope.log;
}
//# sourceMappingURL=logger.js.map