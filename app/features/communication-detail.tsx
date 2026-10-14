"use client";
import { Button, type CommunicationItem, type Company } from "./shared";

type Props = {
  id: string;
  companies: Company[];
  onBack: () => void;
  onEdit: (item: CommunicationItem) => void;
  onDuplicate: (item: CommunicationItem) => void;
  onToast: (message: string) => void;
};

// Placeholder: the delivery view lands in the next task. The list already opens sent and scheduled communications here, so the way back works.
export function CommunicationDetail({ id, onBack }: Props) {
  return (
    <div className="page-stack management-page">
      <p>{id}: the delivery view is coming in the next task.</p>
      <div>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
