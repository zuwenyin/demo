// 统一出口，html 里 import 本文件即可自动挂载全局 Logger / log
import { mountGlobal } from './logger.js';
export * from './logger.js';
export { logger as default } from './logger.js';
mountGlobal();
//# sourceMappingURL=index.js.map