#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"

create_queue() {
  local name="$1"
  shift
  awslocal sqs create-queue \
    --region "$REGION" \
    --queue-name "$name" \
    "$@" >/dev/null
}

queue_arn() {
  awslocal sqs get-queue-attributes \
    --region "$REGION" \
    --queue-url "$1" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text
}

# Cria primeiro as DLQs.
create_queue wagering-events-dlq \
  --attributes '{"MessageRetentionPeriod":"1209600"}'

create_queue wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}'

EVENT_DLQ_URL="$(
  awslocal sqs get-queue-url \
    --region "$REGION" \
    --queue-name wagering-events-dlq \
    --query QueueUrl --output text
)"

COMMAND_DLQ_URL="$(
  awslocal sqs get-queue-url \
    --region "$REGION" \
    --queue-name wager-transactions-dlq.fifo \
    --query QueueUrl --output text
)"

EVENT_DLQ_ARN="$(queue_arn "$EVENT_DLQ_URL")"
COMMAND_DLQ_ARN="$(queue_arn "$COMMAND_DLQ_URL")"

# Cria as filas de origem com redrive após 5 recebimentos.
create_queue wagering-events \
  --attributes "$(printf \
    '{"VisibilityTimeout":"30","RedrivePolicy":"%s"}' \
    "$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$EVENT_DLQ_ARN" | sed 's/"/\\"/g')")"

create_queue wager-transactions.fifo \
  --attributes "$(printf \
    '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"%s"}' \
    "$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$COMMAND_DLQ_ARN" | sed 's/"/\\"/g')")"

echo "Wagering SQS queues and DLQs are ready."