import inquirer from "inquirer";
import script from "./index.js";
import axios from "axios";
import { execSync } from "child_process";

console.log("\nHello there!\n");

// Get git config defaults
let defaultName = "Your Name";
let defaultEmail = "your.email@example.com";

try {
  defaultName = execSync("git config user.name", { encoding: "utf-8" }).trim();
} catch (e) {
  // Ignore if git config not set
}

try {
  defaultEmail = execSync("git config user.email", { encoding: "utf-8" }).trim();
} catch (e) {
  // Ignore if git config not set
}

const questions = [
  {
    type: "input",
    name: "username",
    message:
      "Please enter GitHub nickname with which you'd like to sync contributions:",
    validate: (value) =>
      axios
        .get(`https://api.github.com/users/${value}`)
        .then(() => true)
        .catch(() => "Please enter an existing GitHub username."),
  },
  {
    type: "input",
    name: "personalName",
    message: "Enter the name for commit author (will appear in git history):",
    default: defaultName,
  },
  {
    type: "input",
    name: "personalEmail",
    message: "Enter the email for commit author (must be linked to your GitHub account):",
    default: defaultEmail,
    validate: (value) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return "Please enter a valid email address.";
      }
      return true;
    },
  },
  {
    type: "input",
    name: "year",
    message: "What year would you like to sync?",
    default() {
      return new Date().getFullYear();
    },
  },
  {
    type: "confirm",
    name: "enableBatching",
    message: "Enable batched imports? (Import in chunks with delays)",
    default: true,
  },
  {
    type: "input",
    name: "batchSize",
    message: "How many contributions per batch?",
    default: 500,
    when: (answers) => answers.enableBatching,
    validate: (value) => {
      const num = parseInt(value);
      return num > 0 && num <= 5000 ? true : "Please enter a number between 1 and 5000";
    },
  },
  {
    type: "input",
    name: "batchDelayMinutes",
    message: "Delay between batches (in minutes)?",
    default: 5,
    when: (answers) => answers.enableBatching,
    validate: (value) => {
      const num = parseInt(value);
      return num >= 0 && num <= 60 ? true : "Please enter a number between 0 and 60";
    },
  },
  {
    type: "list",
    message: "How would you like this to happen?",
    name: "execute",
    choices: [
      {
        name: `Generate a bash script & execute it immediately.\n  Note: it *will* push to origin main and it would be difficult to undo.`,
        value: true,
      },
      {
        name: "Only generate, no execution.",
        value: false,
      },
    ],
    default: () => false,
  },
  {
    type: "confirm",
    name: "confirm",
    message: "Ready to proceed?",
  },
];

inquirer.prompt(questions).then((answers) => {
  if (answers.confirm) {
    script(answers);
  }
});
