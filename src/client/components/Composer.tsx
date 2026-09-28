import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { Microphone } from "@phosphor-icons/react/Microphone";
import { X } from "@phosphor-icons/react/X";
import type { FileUIPart } from "ai";
import {
	useEffect,
	useState,
	type ClipboardEvent,
	type Dispatch,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	type SetStateAction,
} from "react";
import { canDictate, useDictation } from "../dictation.js";
import { MAX_PHOTOS, fitsPhotoBudget, preparePhoto } from "../photo-attachments.js";
import { toasts } from "../toasts.js";

const photoError = (title: string) => toasts.add({ title, variant: "error" });

const SIZES = {
	compact: {
		card: "rounded-[20px] p-2",
		input: "chat-text-input min-h-10 px-2 pt-1.5 pb-1",
		maxHeight: 160,
		button: "size-8",
	},
	hero: {
		card: "rounded-[24px] p-3",
		input: "min-h-[84px] px-2 pt-2 pb-3 text-[15px] leading-relaxed sm:text-base",
		maxHeight: 240,
		button: "size-9",
	},
};

function fitHeight(el: HTMLTextAreaElement, maxHeight: number) {
	el.style.height = "0px";
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}

/** Chat input card: photo thumbnails, a growing textarea, and a control row. */
export function Composer({
	inputRef,
	value,
	onValueChange,
	onKeyDown,
	photos,
	onPhotosChange,
	onPhotosPendingChange,
	photosDisabled = false,
	label,
	placeholder,
	describedBy,
	disabled = false,
	size = "compact",
	actions,
}: {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	value: string;
	onValueChange: Dispatch<SetStateAction<string>>;
	onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	photos: FileUIPart[];
	onPhotosChange: Dispatch<SetStateAction<FileUIPart[]>>;
	/** Photos are still being prepared; the parent should hold off sending. */
	onPhotosPendingChange?: (pending: boolean) => void;
	photosDisabled?: boolean;
	label?: string;
	placeholder: string;
	describedBy?: string;
	disabled?: boolean;
	size?: keyof typeof SIZES;
	actions: ReactNode;
}) {
	const sizing = SIZES[size];
	const [addingPhotos, setAddingPhotos] = useState(false);
	const [dictationSupported] = useState(canDictate);
	const dictation = useDictation((text) => {
		onValueChange((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
		inputRef.current?.focus();
	});

	// Grow the textarea with its content, up to a cap (CSS sets the minimum).
	useEffect(() => {
		if (inputRef.current) fitHeight(inputRef.current, sizing.maxHeight);
	}, [inputRef, value, sizing.maxHeight]);

	// Content wraps differently at a new width (first layout, window or chat
	// panel resize), so re-fit then too. Height-only changes are our own.
	useEffect(() => {
		const el = inputRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let width = el.clientWidth;
		let timer = 0;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			// Resizing inside the observer callback trips its loop warning.
			window.clearTimeout(timer);
			timer = window.setTimeout(() => fitHeight(el, sizing.maxHeight));
		});
		observer.observe(el);
		return () => {
			window.clearTimeout(timer);
			observer.disconnect();
		};
	}, [inputRef, sizing.maxHeight]);

	const addPhotos = async (files: File[]) => {
		if (!files.length) return;
		const slots = MAX_PHOTOS - photos.length;
		if (files.length > slots) photoError(`Add up to ${MAX_PHOTOS} photos per message.`);
		setAddingPhotos(true);
		onPhotosPendingChange?.(true);
		try {
			const results = await Promise.allSettled(files.slice(0, slots).map(preparePhoto));
			const prepared = results.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			if (prepared.length < results.length) photoError("Some photos couldn't be read.");
			// Adds are serialized by `addingPhotos`, so `photos` can only have
			// shrunk since this began; the check is safe for the append below.
			if (!fitsPhotoBudget([...photos, ...prepared])) {
				photoError("These photos are too large to send together.");
				return;
			}
			onPhotosChange((current) => [...current, ...prepared]);
		} finally {
			setAddingPhotos(false);
			onPhotosPendingChange?.(false);
		}
	};

	const removePhoto = (index: number) => {
		onPhotosChange((current) => current.filter((_, i) => i !== index));
		inputRef.current?.focus();
	};

	const pickerDisabled = disabled || photosDisabled || addingPhotos || photos.length >= MAX_PHOTOS;
	const pickerTitle = photosDisabled
		? "Add photos after the queued message sends"
		: photos.length >= MAX_PHOTOS
			? `Maximum ${MAX_PHOTOS} photos attached`
			: "Add photos";

	const pastePhotos = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const images = Array.from(event.clipboardData.files).filter((file) =>
			file.type.startsWith("image/"),
		);
		if (!images.length) return;
		// Office apps and spreadsheets put a picture of the selection beside its
		// text; keep the text. Copied files carry only their names as text.
		const names = new Set(Array.from(event.clipboardData.files, (file) => file.name));
		const text = event.clipboardData.getData("text/plain").trim();
		if (text && !text.split(/\r?\n|\r/).every((line) => names.has(line.trim()))) return;
		event.preventDefault();
		if (photosDisabled) photoError("Add photos after the queued message sends.");
		else if (addingPhotos) photoError("Wait for the previous photos to finish adding.");
		else void addPhotos(images);
	};

	return (
		<div
			className={`flex flex-col border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.04),0_10px_28px_-14px_oklch(0_0_0/0.22)] transition-[border-color] duration-150 focus-within:border-border-strong ${sizing.card}`}
		>
			{photos.length ? (
				<ul aria-label="Attached photos" className="flex flex-wrap gap-2 px-1 pt-1 pb-1.5">
					{photos.map((photo, index) => (
						<li key={`${index}-${photo.url.length}`} className="relative">
							<img
								src={photo.url}
								alt={photo.filename ?? "Attached photo"}
								className="size-14 rounded-xl border border-border object-cover"
							/>
							<button
								type="button"
								onClick={() => removePhoto(index)}
								aria-label={`Remove photo ${index + 1}`}
								title="Remove photo"
								className="absolute -end-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-text-primary text-surface-raised shadow-sm transition-transform duration-150 before:absolute before:-inset-1.5 before:content-[''] hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							>
								<X size={10} weight="bold" aria-hidden="true" />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<textarea
				ref={inputRef}
				value={value}
				onChange={(event) => onValueChange(event.target.value)}
				onKeyDown={onKeyDown}
				onPaste={pastePhotos}
				disabled={disabled}
				placeholder={
					dictation.state === "recording"
						? "Listening…"
						: dictation.state === "transcribing"
							? "Transcribing…"
							: placeholder
				}
				rows={1}
				aria-label={label}
				aria-describedby={describedBy}
				className={`chat-composer-input w-full resize-none overflow-y-auto bg-transparent text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50 ${sizing.input}`}
			/>
			<div className="flex items-center gap-1.5">
				<label
					title={pickerTitle}
					className={`${sizing.button} flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-border text-text-secondary active:scale-[0.94] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40 has-[:disabled]:active:scale-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent hover:bg-surface-sunken hover:text-text-primary`}
				>
					<input
						type="file"
						accept="image/*"
						multiple
						aria-label="Add photos"
						disabled={pickerDisabled}
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							// Reset so choosing the same photo again still fires a change.
							event.target.value = "";
							void addPhotos(files);
						}}
						className="sr-only"
					/>
					{addingPhotos ? (
						<CircleNotch size={16} weight="bold" aria-hidden="true" className="animate-spin" />
					) : (
						<ImageSquare size={16} weight="bold" aria-hidden="true" />
					)}
				</label>
				<div className="ms-auto flex items-center gap-1.5">
					{dictationSupported ? (
						<button
							type="button"
							onClick={dictation.state === "recording" ? dictation.stop : dictation.start}
							// Stay stoppable even if the composer is disabled mid-recording.
							disabled={
								dictation.state === "transcribing" || (disabled && dictation.state !== "recording")
							}
							aria-label={
								dictation.state === "recording"
									? "Stop dictation"
									: dictation.state === "transcribing"
										? "Transcribing dictation"
										: "Start dictation"
							}
							title={dictation.state === "recording" ? "Stop dictation" : "Dictate"}
							className={`${sizing.button} flex shrink-0 items-center justify-center rounded-full border transition-[background-color,color,scale] duration-150 active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:active:scale-100 ${dictation.state === "recording" ? "border-transparent bg-accent-light text-accent-text" : "border-border text-text-secondary hover:bg-surface-sunken hover:text-text-primary disabled:opacity-40"}`}
						>
							{dictation.state === "recording" ? (
								<span aria-hidden="true" className="flex h-3.5 items-center gap-[2.5px]">
									{[0, 1, 2].map((bar) => (
										<span
											key={bar}
											className="dictation-bar h-full w-[2.5px] rounded-full bg-current"
											style={{ animationDelay: `${bar * 150}ms` }}
										/>
									))}
								</span>
							) : dictation.state === "transcribing" ? (
								<CircleNotch size={15} weight="bold" aria-hidden="true" className="animate-spin" />
							) : (
								<Microphone size={15} weight="bold" aria-hidden="true" />
							)}
						</button>
					) : null}
					{actions}
				</div>
			</div>
		</div>
	);
}
