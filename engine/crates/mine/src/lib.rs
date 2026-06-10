//! 因子挖掘框架：公式化因子的遗传规划搜索。
//!
//! 范式与学术依据：
//! - 公式化 alpha（WorldQuant "101 Formulaic Alphas", Kakushadze 2016）
//! - 以横截面 IC/ICIR 为适应度的进化搜索（AlphaGen, Yu et al. 2023 思想，
//!   此处用遗传规划替代 RL；适应度 = 时间折 IC 均值 − λ·折间波动）
//! - 防过拟合：复杂度惩罚 + 留出期从不参与挖掘 + 与因子库的正交性约束
//!
//! 流程：表达式树（AST）→ 按标的求值 → 每日横截面 z 分 →
//! 与下期收益的横截面相关（IC）→ 适应度 → 进化。

pub mod expr;
pub mod gp;
pub mod panel;

pub use expr::Expr;
pub use gp::{mine, MineConfig, MinedFactor, MineReport};
pub use panel::Panel;
