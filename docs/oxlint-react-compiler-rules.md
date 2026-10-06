# oxlint 规则说明

.oxlintrc.json 关闭的 react/refs、react/immutability、react/set-state-in-effect、
react/globals、react/preserve-manual-memoization 五条是 oxlint 1.87 引入的
React Compiler 提示系规则：升级时对存量代码报告 69 处（2026-10-06），均为
渲染期 ref 访问等既有惯用法，无行为影响。按防腐约定钉住存量、只减不增，
随 React Compiler 采纳逐批偿还后移除对应规则。
