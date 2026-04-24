import { z } from "../types.js";

const SUPPORTED_OPS = ["==", "!=", ">", "<", ">=", "<=", "contains", "startsWith", "endsWith"];

function evaluate(left, op, right) {
  // Coerce numbers when both sides look numeric
  const lNum = Number(left);
  const rNum = Number(right);
  const bothNumeric = !isNaN(lNum) && !isNaN(rNum);

  const l = bothNumeric ? lNum : String(left ?? "");
  const r = bothNumeric ? rNum : String(right ?? "");

  switch (op) {
    case "==":         return l == r;
    case "!=":         return l != r;
    case ">":          return l > r;
    case "<":          return l < r;
    case ">=":         return l >= r;
    case "<=":         return l <= r;
    case "contains":   return String(l).includes(String(r));
    case "startsWith": return String(l).startsWith(String(r));
    case "endsWith":   return String(l).endsWith(String(r));
    default:           return false;
  }
}

export const conditionLogic = {
  id: "logic:condition",
  category: "logic",
  name: "Condition (Si/Sinon)",
  description: "Branche le workflow selon une condition. Deux sorties : Vrai / Faux.",
  icon: "GitBranch",
  color: "#e74c3c",

  inputSchema: z.object({
    leftOperand:  z.string().describe("Valeur gauche (peut contenir {{variables}})"),
    operator:     z.enum(["==", "!=", ">", "<", ">=", "<=", "contains", "startsWith", "endsWith"]),
    rightOperand: z.string().describe("Valeur droite"),
  }),

  outputSchema: z.object({
    result:       z.boolean().describe("Résultat de la condition"),
    leftOperand:  z.string(),
    rightOperand: z.string(),
    operator:     z.string(),
  }),

  async execute(inputs, context) {
    const { leftOperand = "", operator = "==", rightOperand = "" } = inputs;

    if (!SUPPORTED_OPS.includes(operator)) {
      throw new Error(`Opérateur non supporté: ${operator}`);
    }

    const result = evaluate(leftOperand, operator, rightOperand);

    return { result, leftOperand, rightOperand, operator };
  },
};
