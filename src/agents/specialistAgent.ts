import { AgentRoleConfig, LLMService, Message, MessageType } from '../types';
import { Agent } from './agent';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';

/**
 * A specialist agent that focuses on a single domain (frontend, backend,
 * testing, etc.). Receives tasks from the Team Lead, executes them
 * iteratively, and reports back.
 */
export class SpecialistAgent extends Agent {
  constructor(
    roleConfig: AgentRoleConfig,
    messageBus: MessageBus,
    fileManager: FileManager,
    llm: LLMService
  ) {
    super(roleConfig, messageBus, fileManager, llm);
  }

  protected handleMessage(message: Message): void {
    switch (message.type) {
      case MessageType.TaskAssigned:
        this.log(`Received task assignment: ${JSON.stringify(message.payload)}`);
        break;

      case MessageType.Question:
        this.handleIncomingQuestion(message);
        break;

      case MessageType.Answer:
        this.log(`Received answer from ${message.fromAgentId}`);
        // Feed the answer back into conversation context
        this.conversationHistory.push({
          role: 'user',
          content: `Answer from team member: ${JSON.stringify(message.payload)}`,
        });
        break;

      case MessageType.TeamDirective:
        this.handleDirective(message);
        break;

      case MessageType.ReviewResult:
        this.handleReviewResult(message);
        break;

      case MessageType.BlockerResolved:
        this.log(`Blocker resolved: ${JSON.stringify(message.payload)}`);
        this.state.blockerDescription = null;
        break;

      default:
        break;
    }
  }

  private handleIncomingQuestion(message: Message): void {
    const payload = message.payload as { question: string };
    this.log(`Question from ${message.fromAgentId}: ${payload.question}`);

    // Add question to conversation so agent can answer it in next iteration
    this.conversationHistory.push({
      role: 'user',
      content: `A team member (${message.fromAgentId}) asks: ${payload.question}\nPlease answer based on your current work.`,
    });
  }

  private handleDirective(message: Message): void {
    const payload = message.payload as { directive: string };
    this.log(`Team Lead directive: ${payload.directive}`);

    this.conversationHistory.push({
      role: 'user',
      content: `Team Lead directive: ${payload.directive}\nPlease adjust your work accordingly.`,
    });
  }

  private handleReviewResult(message: Message): void {
    const payload = message.payload as {
      approved: boolean;
      feedback: string;
    };
    this.log(
      `Review result: ${payload.approved ? 'APPROVED' : 'CHANGES REQUESTED'}`
    );

    if (!payload.approved) {
      this.conversationHistory.push({
        role: 'user',
        content: `Code review feedback (changes requested):\n${payload.feedback}\nPlease address this feedback.`,
      });
    }
  }
}
