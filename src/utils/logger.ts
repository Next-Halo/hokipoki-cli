import chalk from 'chalk';

export class Logger {
  constructor(private context?: string) {}

  private getPrefix(): string {
    return this.context ? `[${this.context}] ` : '';
  }

  info(message: string): void {
    console.log(chalk.cyan(`${this.getPrefix()}${message}`));
  }

  debug(message: string): void {
    console.log(chalk.gray(`${this.getPrefix()}${message}`));
  }

  error(message: string): void {
    console.error(chalk.red(`${this.getPrefix()}${message}`));
  }

  warn(message: string): void {
    console.warn(chalk.yellow(`${this.getPrefix()}${message}`));
  }

  success(message: string): void {
    console.log(chalk.green(`${this.getPrefix()}${message}`));
  }
}