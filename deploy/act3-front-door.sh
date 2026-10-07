#!/bin/bash
# NOAI+ ACT III demo: the https front door (CloudFront) for the demo server,
# then tell the server its public address, then a USD 20 spending alert.
# Run in AWS CloudShell, eu-north-1, in the account that runs the server.
set -euo pipefail
INSTANCE=${INSTANCE:?set INSTANCE to the server id}
ALERT_EMAIL=${ALERT_EMAIL:?set ALERT_EMAIL}
ORIGIN=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query "Reservations[0].Instances[0].PublicDnsName" --output text)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# "/" opens the chat page.
cat > /tmp/root-to-chat.js <<'EOF'
function handler(event) {
  var r = event.request;
  if (r.uri === '/') return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: '/chat' } } };
  return r;
}
EOF
ETAG=$(aws cloudfront create-function --name noai-root-to-chat --function-config Comment="open /chat",Runtime=cloudfront-js-2.0 --function-code fileb:///tmp/root-to-chat.js --query ETag --output text)
FN_ARN=$(aws cloudfront publish-function --name noai-root-to-chat --if-match "$ETAG" --query FunctionSummary.FunctionMetadata.FunctionARN --output text)

cat > /tmp/dist.json <<EOF
{
  "CallerReference": "noai-actiii-$(date +%s)",
  "Comment": "NOAI+ ACT III demo",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3",
  "Origins": { "Quantity": 1, "Items": [ {
    "Id": "noai-gateway",
    "DomainName": "$ORIGIN",
    "CustomOriginConfig": { "HTTPPort": 7794, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only", "OriginReadTimeout": 60, "OriginKeepaliveTimeout": 5,
      "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] } }
  } ] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "noai-gateway",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"], "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] } },
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3",
    "Compress": false,
    "FunctionAssociations": { "Quantity": 1, "Items": [ { "EventType": "viewer-request", "FunctionARN": "$FN_ARN" } ] }
  }
}
EOF
DOMAIN=$(aws cloudfront create-distribution --distribution-config file:///tmp/dist.json --query Distribution.DomainName --output text)
echo "LINK: https://$DOMAIN"

# The server only answers pages asked for at its own public address.
aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "NOAI public address" \
  --parameters "commands=[\"until grep -q NOAI-SETUP-DONE /var/log/noai-setup.log; do sleep 5; done\",\"sed -i 's#^NOAI_GATEWAY_ALLOWED_ORIGINS=.*#NOAI_GATEWAY_ALLOWED_ORIGINS=https://$DOMAIN#' /etc/noai/env\",\"systemctl restart noai-gateway\"]" \
  --timeout-seconds 1800 --query Command.CommandId --output text

# A spending alert at USD 20.
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget '{"BudgetName":"noai-demo-usd20","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]}]"
echo ALL-DONE
