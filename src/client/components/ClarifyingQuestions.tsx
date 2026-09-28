import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Check } from "@phosphor-icons/react/Check";
import { Question } from "@phosphor-icons/react/Question";
import { X } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState } from "react";
import {
	createQuestionAnswers,
	setQuestionCustomAnswer,
	toggleQuestionOption,
	type ClarifyingQuestion,
	type QuestionAnswer,
} from "../../shared/questionnaire.js";

export interface ClarifyingQuestionsProps {
	toolCallId: string;
	questions: ClarifyingQuestion[];
	open?: boolean;
	disabled?: boolean;
	submitting?: boolean;
	onSubmit: (answers: QuestionAnswer[]) => void;
	onDismiss: () => void;
}

export function ClarifyingQuestions({
	toolCallId,
	questions,
	open = true,
	disabled = false,
	submitting = false,
	onSubmit,
	onDismiss,
}: ClarifyingQuestionsProps) {
	const [answers, setAnswers] = useState(() => createQuestionAnswers(questions));
	const [current, setCurrent] = useState(0);
	const [direction, setDirection] = useState<"forward" | "back">("forward");
	const [phase, setPhase] = useState<"initial" | "idle" | "exit" | "enter">("initial");
	const pendingQuestionRef = useRef<number | null>(null);
	const legendRef = useRef<HTMLLegendElement>(null);

	useEffect(() => {
		setAnswers(createQuestionAnswers(questions));
		setCurrent(0);
		setDirection("forward");
		setPhase("initial");
		pendingQuestionRef.current = null;
		// A parser may return a new questions array on every chat update. Reset only
		// when the persisted tool call itself changes.
	}, [toolCallId]);

	useEffect(() => {
		if (open) legendRef.current?.focus();
	}, [current, open]);

	const total = questions.length;
	const question = questions[current];
	const answer = answers[current];
	if (!question || !answer || total === 0) return null;

	const isLast = current === total - 1;
	const isAnswered = answer.selected.length > 0 || answer.custom.trim().length > 0;
	const unavailable = disabled || submitting || !open;
	const transitioning = phase === "exit" || phase === "enter";

	const moveTo = (next: number, nextDirection: "forward" | "back") => {
		setDirection(nextDirection);
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			setCurrent(next);
			return;
		}
		pendingQuestionRef.current = next;
		setPhase("exit");
	};

	const goBack = () => {
		moveTo(Math.max(0, current - 1), "back");
	};

	const goNext = () => {
		if (isLast) {
			onSubmit(answers);
			return;
		}
		moveTo(Math.min(total - 1, current + 1), "forward");
	};

	const onQuestionAnimationEnd = (event: React.AnimationEvent<HTMLFieldSetElement>) => {
		event.stopPropagation();
		if (phase === "initial") {
			setPhase("idle");
		} else if (phase === "exit" && pendingQuestionRef.current !== null) {
			setCurrent(pendingQuestionRef.current);
			pendingQuestionRef.current = null;
			setPhase("enter");
		} else if (phase === "enter") {
			setPhase("idle");
		}
	};

	const questionAnimation =
		phase === "initial"
			? "questionnaire-question-initial"
			: phase === "exit"
				? `questionnaire-question-exit-${direction}`
				: phase === "enter"
					? `questionnaire-question-enter-${direction}`
					: "";

	return (
		<div className="questionnaire-shell" data-open={open ? "true" : "false"} aria-hidden={!open}>
			<div className="questionnaire-shell-inner">
				<section
					className="questionnaire-card relative z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised p-3 text-text-primary shadow-sm"
					aria-label="Clarifying questions"
				>
					<div className="mb-2.5 flex shrink-0 items-start gap-2.5">
						<span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
							<Question size={16} weight="bold" aria-hidden="true" />
						</span>
						<div className="min-w-0 flex-1">
							<h3 className="text-sm font-medium">Clarifying questions</h3>
							<p className="mt-0.5 text-xs leading-4 text-text-tertiary">
								Answer to help me build what you want.
							</p>
						</div>
						<span className="sr-only" aria-live="polite">
							Question {current + 1} of {total}
						</span>
						<div className="-mt-1 -me-1 flex shrink-0 items-center gap-2">
							<span
								className="flex h-8 items-center text-xs font-medium text-text-tertiary tabular-nums"
								aria-hidden="true"
							>
								{current + 1}/{total}
							</span>
							<button
								type="button"
								onClick={onDismiss}
								disabled={unavailable}
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
								aria-label="Skip all questions"
							>
								<X size={16} aria-hidden="true" />
							</button>
						</div>
					</div>

					<div className="mb-3 flex shrink-0 gap-1" aria-hidden="true">
						{questions.map((_, index) => (
							<span
								key={index}
								className={`h-1 flex-1 rounded-full ${index < current ? "bg-accent" : index === current ? "bg-accent/60" : "bg-surface-sunken"}`}
							/>
						))}
					</div>

					<div className="questionnaire-body -m-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain p-1">
						<fieldset
							key={current}
							onAnimationEnd={onQuestionAnimationEnd}
							className={`questionnaire-question ${questionAnimation} m-0 flex min-w-0 flex-col border-0 p-0`}
						>
							<legend
								ref={legendRef}
								tabIndex={-1}
								className="block max-w-full p-0 text-sm leading-5 font-medium break-words [overflow-wrap:anywhere] outline-none"
							>
								{question.question}
							</legend>

							<div className="mt-2 flex flex-col gap-2">
								{question.options && question.options.length > 0 ? (
									<div className="flex flex-col gap-1">
										{question.options.map((option) => {
											const checked = answer.selected.includes(option);
											const inputType = question.allow_multiple ? "checkbox" : "radio";
											return (
												<label
													key={option}
													className={`flex min-h-10 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-sm leading-5 transition-colors ${checked ? "bg-surface-sunken text-text-primary" : "text-text-secondary hover:bg-surface-sunken"}`}
												>
													<input
														type={inputType}
														name={`questionnaire-${toolCallId}-${current}`}
														value={option}
														checked={checked}
														disabled={unavailable}
														onChange={() =>
															setAnswers((value) =>
																toggleQuestionOption(value, questions, current, option),
															)
														}
														className="peer sr-only"
													/>
													<span
														aria-hidden="true"
														className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-border-strong bg-surface-raised shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-50 ${question.allow_multiple ? "rounded-sm peer-checked:border-text-primary peer-checked:bg-text-primary peer-checked:text-surface-raised" : "rounded-full"}`}
													>
														{question.allow_multiple ? (
															<Check
																size={12}
																weight="bold"
																className={checked ? "opacity-100" : "opacity-0"}
															/>
														) : (
															<span
																className={`h-2 w-2 rounded-full bg-text-primary ${checked ? "opacity-100" : "opacity-0"}`}
															/>
														)}
													</span>
													<span className="min-w-0 break-words [overflow-wrap:anywhere]">
														{option}
													</span>
												</label>
											);
										})}
									</div>
								) : null}

								{question.allow_custom !== false ? (
									<input
										type="text"
										value={answer.custom}
										onChange={(event) =>
											setAnswers((value) =>
												setQuestionCustomAnswer(value, current, event.target.value),
											)
										}
										disabled={unavailable}
										maxLength={1_000}
										placeholder={
											question.options?.length ? "Or add your own answer" : "Type your answer"
										}
										aria-label={`Custom answer for ${question.question}`}
										className="questionnaire-custom-input chat-text-input min-w-0 rounded-lg border border-border-strong bg-surface px-3 text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
									/>
								) : null}
							</div>
						</fieldset>
					</div>

					<div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={goBack}
							disabled={unavailable || transitioning || current === 0}
							className="flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium whitespace-nowrap text-text-tertiary transition-colors hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 sm:h-9"
						>
							<ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
							Back
						</button>
						<div className="ms-auto flex flex-wrap items-center justify-end gap-2">
							<button
								type="button"
								onClick={goNext}
								disabled={unavailable || transitioning}
								className="h-10 rounded-lg border border-border-strong bg-surface-raised px-3 text-sm font-medium whitespace-nowrap text-text-secondary shadow-sm transition-[background-color,scale] hover:bg-surface-sunken active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 motion-reduce:scale-100 motion-reduce:transition-none sm:h-9"
							>
								{isLast ? "Skip & finish" : "Skip"}
							</button>
							<button
								type="button"
								onClick={goNext}
								disabled={unavailable || transitioning || !isAnswered}
								className="flex h-10 items-center gap-1 rounded-lg bg-text-primary px-3 text-sm font-medium whitespace-nowrap text-surface-raised shadow-sm transition-[opacity,scale] hover:opacity-85 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 motion-reduce:scale-100 motion-reduce:transition-none sm:h-9"
							>
								{isLast ? (
									<>
										<Check size={16} aria-hidden="true" />
										Submit
									</>
								) : (
									<>
										Next
										<ArrowRight size={16} className="rtl:-scale-x-100" aria-hidden="true" />
									</>
								)}
							</button>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
